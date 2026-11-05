import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { checkRateLimit, rateLimitResponse } from '@/lib/rate-limit'
import { contactSearchFilter, contactSearchPattern } from '@/lib/contacts/search-filter'
import { REPORT_TZ, rangeBounds, todayInTz } from '@/lib/contacts/date-range'
import { buildContactsWorkbook, type ExportContact } from '@/lib/contacts/export-xlsx'
import { isIsoDate } from '@/lib/followups/dates'

const PAGE = 1000
const MAX_ROWS = 20_000
const ID_RE = /^[0-9a-fA-F-]{8,64}$/
const chunk = <T,>(a: T[], n: number) =>
  Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n))

interface ContactRow {
  id: string
  name?: string | null
  phone: string
  created_at: string
}

// GET /api/contacts/export?from=YYYY-MM-DD&to=YYYY-MM-DD&q=...&tags=id1,id2
// Downloads an .xlsx of the contacts matching the SAME filters as the Contacts page.
export async function GET(request: Request) {
  try {
    const { supabase, userId } = await requireRole('agent')
    const limit = checkRateLimit(`contacts-export:${userId}`, { limit: 6, windowMs: 60_000 })
    if (!limit.success) return rateLimitResponse(limit)

    const sp = new URL(request.url).searchParams
    const from = sp.get('from') ?? ''
    const to = sp.get('to') ?? ''
    const q = (sp.get('q') ?? '').slice(0, 100).trim()
    const tagIds = (sp.get('tags') ?? '').split(',').filter(Boolean)
    if ((from && !isIsoDate(from)) || (to && !isIsoDate(to)) || tagIds.some((t) => !ID_RE.test(t)) || tagIds.length > 50) {
      return NextResponse.json({ error: 'Invalid filters' }, { status: 400 })
    }
    const { fromIso, toIsoExclusive } = rangeBounds(from, to)

    // ---- 1) the contacts (same filter rules as the Contacts page) ----
    const contacts: ContactRow[] = []
    for (let offset = 0; offset < MAX_ROWS + PAGE; offset += PAGE) {
      let rows: ContactRow[]
      if (tagIds.length > 0) {
        const { data, error } = await supabase.rpc('filter_contacts_by_tags_dated', {
          p_tag_ids: tagIds,
          p_search: contactSearchPattern(q),
          p_from: fromIso,
          p_to: toIsoExclusive,
          p_limit: PAGE,
          p_offset: offset,
        })
        if (error) return NextResponse.json({ error: 'Could not load contacts (is migration 063 applied?)' }, { status: 500 })
        rows = ((data ?? []) as Array<{ contact: ContactRow }>).map((r) => r.contact)
      } else {
        let query = supabase
          .from('contacts')
          .select('id, name, phone, created_at')
          .order('created_at', { ascending: false })
          .order('id')
          .range(offset, offset + PAGE - 1)
        const search = contactSearchFilter(q, { includeEmail: true })
        if (search) query = query.or(search)
        if (fromIso) query = query.gte('created_at', fromIso)
        if (toIsoExclusive) query = query.lt('created_at', toIsoExclusive)
        const { data, error } = await query
        if (error) return NextResponse.json({ error: 'Could not load contacts' }, { status: 500 })
        rows = (data ?? []) as ContactRow[]
      }
      contacts.push(...rows)
      if (rows.length < PAGE) break
      if (contacts.length > MAX_ROWS) {
        return NextResponse.json(
          { error: `More than ${MAX_ROWS} contacts match. Narrow the date range and export again.` },
          { status: 413 },
        )
      }
    }

    // ---- 2) tags and follow-up dates for those contacts ----
    const ids = contacts.map((c) => c.id)
    const { data: allTags } = await supabase.from('tags').select('id, name, color')
    const tagById = new Map((allTags ?? []).map((t: { id: string; name: string; color: string }) => [t.id, t]))
    const tagsOf = new Map<string, Array<{ name: string; color?: string | null }>>()
    const followupOf = new Map<string, string>()

    for (const part of chunk(ids, 200)) {
      const [{ data: links }, { data: fups }] = await Promise.all([
        supabase.from('contact_tags').select('contact_id, tag_id').in('contact_id', part),
        supabase
          .from('conversation_followups')
          .select('contact_id, due_date')
          .eq('status', 'pending')
          .in('contact_id', part),
      ])
      for (const l of (links ?? []) as Array<{ contact_id: string; tag_id: string }>) {
        const t = tagById.get(l.tag_id)
        if (!t) continue
        tagsOf.set(l.contact_id, [...(tagsOf.get(l.contact_id) ?? []), { name: t.name, color: t.color }])
      }
      for (const f of (fups ?? []) as Array<{ contact_id: string; due_date: string }>) {
        const cur = followupOf.get(f.contact_id)
        if (!cur || f.due_date < cur) followupOf.set(f.contact_id, f.due_date) // earliest pending
      }
    }

    const out: ExportContact[] = contacts.map((c) => ({
      name: c.name ?? null,
      phone: c.phone,
      followupDate: followupOf.get(c.id) ?? null,
      tags: tagsOf.get(c.id) ?? [],
      createdAt: c.created_at,
    }))
    const buffer = await buildContactsWorkbook(out, REPORT_TZ)

    const label = from || to ? `${from || 'start'}_to_${to || todayInTz()}` : todayInTz()
    return new NextResponse(new Uint8Array(buffer), {
      headers: {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="contacts_${label}.xlsx"`,
        'Cache-Control': 'private, no-store',
        'X-Exported-Count': String(out.length),
      },
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
