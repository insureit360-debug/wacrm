import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { supabaseAdmin } from '@/lib/automations/admin-client'
import { basenameFromUrl } from '@/lib/media/filename'
import {
  CHAT_MEDIA_BUCKET,
  MAX_DELETE_BATCH,
  deleteInboundMedia,
  fileNameOfPath,
  inboundMediaPath,
  listInboundSizes,
  type DeletePorts,
} from '@/lib/media/inbound-media'

const ID_RE = /^[0-9a-fA-F-]{8,64}$/

/** The conversation must belong to the caller's account; nothing else is trusted. */
async function conversationBelongs(conversationId: string, accountId: string) {
  const { data } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('id', conversationId)
    .eq('account_id', accountId)
    .maybeSingle()
  return !!data
}

// GET /api/messages/media?conversation_id=...
// Lists the customer files of one chat that live in your storage (with sizes).
export async function GET(request: Request) {
  try {
    const { accountId } = await requireRole('admin')
    const conversationId = new URL(request.url).searchParams.get('conversation_id') ?? ''
    if (!ID_RE.test(conversationId) || !(await conversationBelongs(conversationId, accountId))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }
    const db = supabaseAdmin()
    const { data, error } = await db
      .from('messages')
      .select('id, content_type, media_url, media_type, content_text, created_at, sender_type, media_deleted_at')
      .eq('conversation_id', conversationId)
      .not('media_url', 'is', null)
      .is('media_deleted_at', null)
      .order('created_at', { ascending: false })
      .limit(500)
    if (error) return NextResponse.json({ error: 'Could not load files' }, { status: 500 })

    const sizes = await listInboundSizes(db.storage, accountId)
    let hostedByWhatsapp = 0
    let other = 0
    const items = []
    for (const m of data ?? []) {
      const path = inboundMediaPath(m.media_url as string, accountId)
      if (!path) {
        if (String(m.media_url).startsWith('/api/whatsapp/media/')) hostedByWhatsapp++
        else other++
        continue
      }
      items.push({
        id: m.id as string,
        contentType: m.content_type as string,
        mimeType: (m.media_type as string | null) ?? null,
        name: basenameFromUrl(m.media_url as string),
        url: m.media_url as string,
        createdAt: m.created_at as string,
        senderType: m.sender_type as string,
        bytes: sizes.get(fileNameOfPath(path)) ?? null,
      })
    }
    return NextResponse.json({ items, hostedByWhatsapp, other })
  } catch (err) {
    return toErrorResponse(err)
  }
}

// POST /api/messages/media  { conversation_id, message_ids: string[], confirm: "DELETE" }
export async function POST(request: Request) {
  try {
    const { accountId, userId } = await requireRole('admin')
    const limit = checkRateLimit(`media-delete:${userId}`, { limit: 10, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const conversationId = String(body?.conversation_id ?? '')
    const ids: unknown = body?.message_ids
    if (body?.confirm !== 'DELETE') {
      return NextResponse.json({ error: 'Confirmation required' }, { status: 400 })
    }
    if (
      !ID_RE.test(conversationId) ||
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_DELETE_BATCH ||
      !ids.every((x) => typeof x === 'string' && ID_RE.test(x))
    ) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }
    if (!(await conversationBelongs(conversationId, accountId))) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const db = supabaseAdmin()
    const ports: DeletePorts = {
      sizes: await listInboundSizes(db.storage, accountId),
      async fetchMessages(list) {
        const { data } = await db
          .from('messages')
          .select('id, media_url, media_deleted_at')
          .eq('conversation_id', conversationId)
          .in('id', list)
        return (data ?? []) as Array<{ id: string; media_url: string | null; media_deleted_at: string | null }>
      },
      async countOtherRefs(url, exceptId) {
        const { count } = await db
          .from('messages')
          .select('id', { count: 'exact', head: true })
          .eq('media_url', url)
          .neq('id', exceptId)
        return count ?? 0
      },
      async claim(id, oldUrl, p) {
        const { data } = await db
          .from('messages')
          .update({ media_url: null, media_deleted_at: p.deletedAt, media_deleted_by: p.deletedBy })
          .eq('id', id)
          .eq('conversation_id', conversationId)
          .eq('media_url', oldUrl)
          .select('id')
        return (data ?? []).length === 1
      },
      async restore(id, oldUrl) {
        const { data } = await db
          .from('messages')
          .update({ media_url: oldUrl, media_deleted_at: null, media_deleted_by: null })
          .eq('id', id)
          .eq('conversation_id', conversationId)
          .is('media_url', null)
          .select('id')
        return (data ?? []).length === 1
      },
      async removeObject(path) {
        const { error } = await db.storage.from(CHAT_MEDIA_BUCKET).remove([path])
        return { error: error ? error.message : null }
      },
    }

    const out = await deleteInboundMedia({ accountId, userId, messageIds: ids as string[], ports })
    return NextResponse.json({
      results: out.results,
      deleted: out.results.filter((r) => r.status === 'deleted').length,
      freedBytes: out.freedBytes,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
