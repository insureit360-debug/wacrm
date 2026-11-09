import { createECDH, randomBytes } from 'node:crypto'
import http from 'node:http'
import https from 'node:https'
import { createRequire } from 'node:module'
import { describe, expect, it, vi } from 'vitest'

// Real `web-push` (NOT mocked); only the database is faked. A local HTTP
// server plays the browser vendor's push service, and we decrypt what it
// receives exactly the way a phone would, to prove the whole server path.

const require = createRequire(import.meta.url)
const ece = require('http_ece') as { decrypt: (data: Buffer, params: Record<string, unknown>) => Buffer }

let rows: Array<{ id: string; endpoint: string; p256dh: string; auth: string }> = []
vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({
    from: () => ({
      select: () => ({ eq: () => ({ eq: async () => ({ data: rows, error: null }), then: (r: (v: unknown) => void) => r({ data: rows, error: null }) }) }),
      delete: () => ({ in: async () => ({}) }),
    }),
  }),
}))

import { getLastPushAttempt, notifyInboundPush } from './server'
import { buildPushPayload } from './payload'

const b64 = (b: Buffer) => b.toString('base64url')

describe('end to end: webhook -> encrypted push -> phone can read it', () => {
  it('delivers an encrypted, VAPID-signed notification the service worker can parse', async () => {
    // VAPID pair + subject (what you put in Coolify)
    const v = createECDH('prime256v1'); v.generateKeys()
    process.env.VAPID_PUBLIC_KEY = b64(v.getPublicKey())
    process.env.VAPID_PRIVATE_KEY = b64(v.getPrivateKey())
    process.env.VAPID_SUBJECT = 'mailto:owner@example.com'

    // The "phone": its own key pair + auth secret, like pushManager.subscribe() makes
    const phone = createECDH('prime256v1'); phone.generateKeys()
    const auth = randomBytes(16)

    // The "push service" (Google/Mozilla): records the request
    const seen: { headers: http.IncomingHttpHeaders; body: Buffer }[] = []
    const server = http.createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c) => chunks.push(c))
      req.on('end', () => { seen.push({ headers: req.headers, body: Buffer.concat(chunks) }); res.statusCode = 201; res.end() })
    })
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
    const port = (server.address() as { port: number }).port

    // web-push only speaks HTTPS; point its HTTPS request at our local "push service".
    const spy = vi.spyOn(https, 'request').mockImplementation(((opts: http.RequestOptions, cb: (res: http.IncomingMessage) => void) =>
      http.request({ ...opts, protocol: 'http:', agent: undefined, hostname: '127.0.0.1', host: '127.0.0.1', port }, cb)) as unknown as typeof https.request)

    rows = [{ id: 's1', endpoint: 'https://push.example.test/push/abc', p256dh: b64(phone.getPublicKey()), auth: b64(auth) }]

    await notifyInboundPush({
      accountId: 'acct',
      payload: buildPushPayload({
        message: { conversation_id: 'conv-9', content_type: 'text', content_text: 'Your car insurance quotation please.' },
        contact: { name: 'Example Customer', phone: '+919999900000' },
      }),
    })
    spy.mockRestore()
    server.close()

    expect(seen).toHaveLength(1)
    const { headers, body } = seen[0]
    expect(headers['content-encoding']).toBe('aes128gcm')
    expect(headers['urgency']).toBe('high')
    expect(headers['authorization']).toMatch(/^vapid t=.+, k=.+$/) // signed with our VAPID key
    expect(headers['authorization']).toContain(`k=${process.env.VAPID_PUBLIC_KEY}`)

    // Decrypt like the phone would, then parse like sw.js does.
    const plain = ece.decrypt(body, { version: 'aes128gcm', privateKey: phone, authSecret: b64(auth) })
    const data = JSON.parse(plain.toString('utf8'))
    expect(data).toMatchObject({
      v: 1,
      conversationId: 'conv-9',
      title: 'Example Customer',
      body: 'Your car insurance quotation please.',
      url: '/inbox?c=conv-9',
    })

    // And the checker's "last alert" line would report success.
    expect(getLastPushAttempt()).toMatchObject({ source: 'message', sent: 1, subscriptions: 1, errors: [] })
  })
})
