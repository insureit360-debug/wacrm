import { describe, expect, it, vi } from 'vitest'
import {
  deleteInboundMedia,
  inboundMediaPath,
  listInboundSizes,
  type DeletePorts,
  type MessageMediaRow,
} from './inbound-media'

const ACC = '11111111-1111-1111-1111-111111111111'
const OTHER = '22222222-2222-2222-2222-222222222222'
const base = 'https://sb.example.com/storage/v1/object/public/chat-media/'
const inbound = (name: string, acc = ACC) => `${base}account-${acc}/inbound/${name}`

describe('inboundMediaPath (what may ever be deleted)', () => {
  it('accepts a mirrored inbound file of this account', () => {
    expect(inboundMediaPath(inbound('123-invoice.pdf'), ACC)).toBe(`account-${ACC}/inbound/123-invoice.pdf`)
    expect(inboundMediaPath(inbound('123-my%20file.pdf'), ACC)).toBe(`account-${ACC}/inbound/123-my file.pdf`)
  })
  it('works whatever host the stored URL used (internal vs public)', () => {
    const u = `http://kong:8000/storage/v1/object/public/chat-media/account-${ACC}/inbound/a.jpg`
    expect(inboundMediaPath(u, ACC)).toBe(`account-${ACC}/inbound/a.jpg`)
  })
  it('refuses everything else', () => {
    expect(inboundMediaPath('/api/whatsapp/media/12345', ACC)).toBeNull() // hosted by WhatsApp
    expect(inboundMediaPath(inbound('a.jpg', OTHER), ACC)).toBeNull() // another account
    expect(inboundMediaPath(`${base}account-${ACC}/1700000-sent.jpg`, ACC)).toBeNull() // outbound upload
    expect(inboundMediaPath(`${base}account-${ACC}/inbound/sub/a.jpg`, ACC)).toBeNull() // nested
    expect(inboundMediaPath(`${base}account-${ACC}/inbound/..%2Fsecret.jpg`, ACC)).toBeNull() // traversal
    expect(inboundMediaPath(`${base}account-${ACC}/inbound/%2e%2e/x`, ACC)).toBeNull()
    expect(inboundMediaPath(`${base}account-${ACC}/inbound/`, ACC)).toBeNull()
    expect(inboundMediaPath('https://evil.example/flow-media/account-x/inbound/a.jpg', ACC)).toBeNull()
    expect(inboundMediaPath(null, ACC)).toBeNull()
  })
})

function ports(rows: MessageMediaRow[], over: Partial<DeletePorts> = {}) {
  const calls: string[] = []
  const p: DeletePorts = {
    sizes: new Map([['a.jpg', 1000], ['b.pdf', 5000]]),
    fetchMessages: async () => rows,
    countOtherRefs: async () => 0,
    claim: vi.fn(async (id) => (calls.push(`claim:${id}`), true)),
    restore: vi.fn(async (id) => (calls.push(`restore:${id}`), true)),
    removeObject: vi.fn(async (path) => (calls.push(`remove:${path}`), { error: null })),
    ...over,
  }
  return { p, calls }
}

describe('deleteInboundMedia', () => {
  it('clears the link, THEN removes the file, and reports bytes freed', async () => {
    const { p, calls } = ports([
      { id: 'm1', media_url: inbound('a.jpg') },
      { id: 'm2', media_url: inbound('b.pdf') },
    ])
    const r = await deleteInboundMedia({ accountId: ACC, userId: 'u', messageIds: ['m1', 'm2'], ports: p })
    expect(r.results.map((x) => x.status)).toEqual(['deleted', 'deleted'])
    expect(r.freedBytes).toBe(6000)
    expect(calls).toEqual([
      'claim:m1', `remove:account-${ACC}/inbound/a.jpg`,
      'claim:m2', `remove:account-${ACC}/inbound/b.pdf`,
    ])
  })

  it('never touches WhatsApp-hosted, outbound, other-account or missing messages', async () => {
    const { p } = ports([
      { id: 'proxy', media_url: '/api/whatsapp/media/999' },
      { id: 'out', media_url: `${base}account-${ACC}/1700-sent.jpg` },
      { id: 'foreign', media_url: inbound('a.jpg', OTHER) },
      { id: 'text', media_url: null },
      { id: 'gone', media_url: null, media_deleted_at: '2026-01-01' },
    ])
    const r = await deleteInboundMedia({
      accountId: ACC, userId: 'u', messageIds: ['proxy', 'out', 'foreign', 'text', 'gone', 'unknown'], ports: p,
    })
    expect(r.results.map((x) => x.reason)).toEqual([
      'not_deletable', 'not_deletable', 'not_deletable', 'no_file', 'already_deleted', 'not_found',
    ])
    expect(p.claim).not.toHaveBeenCalled()
    expect(p.removeObject).not.toHaveBeenCalled()
    expect(r.freedBytes).toBe(0)
  })

  it('restores the message link when the file cannot be removed (nothing lost)', async () => {
    const { p, calls } = ports([{ id: 'm1', media_url: inbound('a.jpg') }], {
      removeObject: async () => ({ error: 'storage down' }),
    })
    const r = await deleteInboundMedia({ accountId: ACC, userId: 'u', messageIds: ['m1'], ports: p })
    expect(r.results[0]).toMatchObject({ status: 'error', reason: 'remove_failed' })
    expect(calls).toContain('restore:m1')
    expect(r.freedBytes).toBe(0)
  })

  it('keeps a file that another message still uses, but clears this message', async () => {
    const { p } = ports([{ id: 'm1', media_url: inbound('a.jpg') }], { countOtherRefs: async () => 1 })
    const r = await deleteInboundMedia({ accountId: ACC, userId: 'u', messageIds: ['m1'], ports: p })
    expect(r.results[0]).toMatchObject({ status: 'deleted', reason: 'shared_kept', bytes: 0 })
    expect(p.removeObject).not.toHaveBeenCalled()
  })

  it('skips if the message changed meanwhile (conditional claim fails) and removes nothing', async () => {
    const { p } = ports([{ id: 'm1', media_url: inbound('a.jpg') }], { claim: async () => false })
    const r = await deleteInboundMedia({ accountId: ACC, userId: 'u', messageIds: ['m1'], ports: p })
    expect(r.results[0]).toMatchObject({ status: 'skipped', reason: 'changed' })
    expect(p.removeObject).not.toHaveBeenCalled()
  })

  it('de-duplicates ids and caps the batch', async () => {
    const { p } = ports([{ id: 'm1', media_url: inbound('a.jpg') }])
    const r = await deleteInboundMedia({ accountId: ACC, userId: 'u', messageIds: ['m1', 'm1', 'm1'], ports: p })
    expect(r.results).toHaveLength(1)
  })
})

describe('listInboundSizes', () => {
  it('reads every page of the account inbound folder', async () => {
    const page = (n: number, start: number) =>
      Array.from({ length: n }, (_, i) => ({ name: `f${start + i}.jpg`, metadata: { size: 10 } }))
    const list = vi
      .fn()
      .mockResolvedValueOnce({ data: page(1000, 0), error: null })
      .mockResolvedValueOnce({ data: page(5, 1000), error: null })
    const storage = { from: () => ({ list }) }
    const sizes = await listInboundSizes(storage, ACC)
    expect(sizes.size).toBe(1005)
    expect(list.mock.calls[0][0]).toBe(`account-${ACC}/inbound`)
  })
})
