import { beforeEach, describe, expect, it, vi } from 'vitest'

const update = vi.fn()
const inFn = vi.fn()
const select = vi.fn()
const requireRole = vi.fn()

vi.mock('@/lib/auth/account', () => ({
  requireRole: (...a: unknown[]) => requireRole(...a),
  toErrorResponse: (e: unknown) => new Response(JSON.stringify({ error: String(e) }), { status: 403 }),
}))
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  rateLimitResponse: () => new Response('{}', { status: 429 }),
}))

import { POST } from './route'

const ID = '11111111-1111-1111-1111-111111111111'
const req = (body: unknown) =>
  new Request('http://x/api/conversations/archive', { method: 'POST', body: JSON.stringify(body) })

beforeEach(() => {
  update.mockReset(); inFn.mockReset(); select.mockReset(); requireRole.mockReset()
  select.mockImplementation(async () => ({ data: [{ id: ID }], error: null }))
  inFn.mockImplementation(() => ({ select }))
  update.mockImplementation(() => ({ in: inFn }))
  requireRole.mockResolvedValue({ userId: 'u', supabase: { from: () => ({ update }) } })
})

describe('POST /api/conversations/archive', () => {
  it('archives: sets ONLY archived_at', async () => {
    const res = await POST(req({ ids: [ID], archived: true }))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ updated: 1, archived: true })
    const patch = update.mock.calls[0][0]
    expect(Object.keys(patch)).toEqual(['archived_at'])
    expect(typeof patch.archived_at).toBe('string')
  })
  it('unarchives: clears archived_at', async () => {
    await POST(req({ ids: [ID], archived: false }))
    expect(update.mock.calls[0][0]).toEqual({ archived_at: null })
  })
  it('requires at least the agent role', async () => {
    await POST(req({ ids: [ID], archived: true }))
    expect(requireRole).toHaveBeenCalledWith('agent')
  })
  it('rejects bad input without touching the database', async () => {
    for (const body of [null, {}, { ids: [], archived: true }, { ids: ['not valid!'], archived: true }, { ids: [ID] }, { ids: [ID], archived: 'yes' }, { ids: Array(501).fill(ID), archived: true }]) {
      expect((await POST(req(body))).status).toBe(400)
    }
    expect(update).not.toHaveBeenCalled()
  })
  it('works in chunks of 100 for big selections', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => `aaaaaaaa-0000-0000-0000-${String(i).padStart(12, '0')}`)
    select.mockImplementation(async () => ({ data: [], error: null }))
    await POST(req({ ids, archived: true }))
    expect(inFn).toHaveBeenCalledTimes(3)
  })
  it('reports failure and does not claim success', async () => {
    select.mockImplementation(async () => ({ data: null, error: { message: 'boom' } }))
    expect((await POST(req({ ids: [ID], archived: true }))).status).toBe(500)
  })
})
