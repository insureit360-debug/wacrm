import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'

const ID_RE = /^[0-9a-fA-F-]{8,64}$/
const MAX_IDS = 500
const CHUNK = 100

// POST /api/conversations/archive  { ids: string[], archived: boolean }
// Archives (or unarchives) chats. Changes ONLY `archived_at` — no message,
// contact, tag, note, follow-up or status is touched. Account-scoped by RLS.
export async function POST(request: Request) {
  try {
    const { supabase, userId } = await requireRole('agent')
    const limit = checkRateLimit(`archive:${userId}`, { limit: 30, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const body = await request.json().catch(() => null)
    const ids: unknown = body?.ids
    if (
      typeof body?.archived !== 'boolean' ||
      !Array.isArray(ids) ||
      ids.length === 0 ||
      ids.length > MAX_IDS ||
      !ids.every((x) => typeof x === 'string' && ID_RE.test(x))
    ) {
      return NextResponse.json({ error: 'Invalid request' }, { status: 400 })
    }

    const archivedAt = body.archived ? new Date().toISOString() : null
    const unique = Array.from(new Set(ids as string[]))
    let updated = 0
    for (let i = 0; i < unique.length; i += CHUNK) {
      const { data, error } = await supabase
        .from('conversations')
        .update({ archived_at: archivedAt })
        .in('id', unique.slice(i, i + CHUNK))
        .select('id')
      if (error) {
        return NextResponse.json({ error: 'Could not update chats', updated }, { status: 500 })
      }
      updated += (data ?? []).length
    }
    return NextResponse.json({ updated, archived: body.archived })
  } catch (err) {
    return toErrorResponse(err)
  }
}
