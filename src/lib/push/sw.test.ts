import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import vm from 'node:vm'
import { describe, expect, it, vi } from 'vitest'

// Executes the real public/sw.js in a sandbox with a fake service-worker
// global, so the push + quick-reply logic is tested as shipped.

type Handler = (event: Record<string, unknown>) => void

function loadSw(opts: { windows?: Array<{ url: string; visibilityState: string }>; fetchImpl?: (...a: unknown[]) => unknown; subscribe?: (o: unknown) => Promise<unknown> } = {}) {
  const handlers: Record<string, Handler> = {}
  const shown: Array<{ title: string; options: Record<string, unknown> }> = []
  const focus = vi.fn(async () => {})
  const navigate = vi.fn(async () => {})
  const openWindow = vi.fn(async () => {})
  const fetchMock = vi.fn(opts.fetchImpl ?? (async () => ({ ok: true, status: 200, json: async () => ({}) })))
  const self = {
    location: { origin: 'https://wa.example.com' },
    addEventListener: (n: string, h: Handler) => {
      handlers[n] = h
    },
    skipWaiting: () => {},
    registration: {
      pushManager: { subscribe: opts.subscribe ?? (async () => ({ toJSON: () => ({}) })) },
      showNotification: async (title: string, options: Record<string, unknown>) => {
        shown.push({ title, options })
      },
    },
    clients: {
      claim: async () => {},
      matchAll: async () =>
        (opts.windows ?? []).map((w) => ({ ...w, focus, navigate })),
      openWindow,
    },
  }
  const code = readFileSync(join(process.cwd(), 'public/sw.js'), 'utf8')
  vm.runInNewContext(code, { self, URL, fetch: fetchMock, Promise, JSON, Date, console, atob, Uint8Array })
  return { handlers, shown, fetchMock, focus, navigate, openWindow }
}

async function fire(h: Handler, event: Record<string, unknown>) {
  const waits: Promise<unknown>[] = []
  h({ ...event, waitUntil: (p: Promise<unknown>) => waits.push(p) })
  await Promise.all(waits)
}

const PAYLOAD = {
  v: 1,
  conversationId: 'conv-1',
  title: 'Example Customer',
  body: 'Your car insurance quotation please.',
  url: '/inbox?c=conv-1',
  tag: 'conv-1',
  ts: 1,
}
const pushEvent = (data: unknown) => ({ data: { json: () => data } })

describe('service worker: push', () => {
  it('shows a notification with Reply (text input) and Open chat actions', async () => {
    const sw = loadSw()
    await fire(sw.handlers.push, pushEvent(PAYLOAD))
    expect(sw.shown).toHaveLength(1)
    const n = sw.shown[0]
    expect(n.title).toBe('Example Customer')
    expect(n.options.tag).toBe('conv-1')
    const actions = n.options.actions as Array<{ action: string; type?: string }>
    expect(actions[0]).toMatchObject({ action: 'reply', type: 'text' })
    expect(actions[1].action).toBe('open')
  })

  it('stays quiet when the user is already viewing that chat', async () => {
    const sw = loadSw({ windows: [{ url: 'https://wa.example.com/inbox?c=conv-1', visibilityState: 'visible' }] })
    await fire(sw.handlers.push, pushEvent(PAYLOAD))
    expect(sw.shown).toHaveLength(0)
  })

  it('still notifies if the open chat is a different conversation', async () => {
    const sw = loadSw({ windows: [{ url: 'https://wa.example.com/inbox?c=other', visibilityState: 'visible' }] })
    await fire(sw.handlers.push, pushEvent(PAYLOAD))
    expect(sw.shown).toHaveLength(1)
  })

  it('always shows something for malformed pushes (browser requirement)', async () => {
    const sw = loadSw()
    await fire(sw.handlers.push, { data: { json: () => { throw new Error('bad') } } })
    expect(sw.shown).toHaveLength(1)
  })
})

describe('service worker: quick reply', () => {
  const data = { url: '/inbox?c=conv-1', conversationId: 'conv-1' }
  const close = () => {}

  it('sends the typed reply through the logged-in session, then confirms', async () => {
    const sw = loadSw()
    await fire(sw.handlers.notificationclick, {
      action: 'reply',
      reply: '  I will check the quotations.  ',
      notification: { data, close },
    })
    expect(sw.fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = sw.fetchMock.mock.calls[0] as [string, { method: string; credentials: string; body: string }]
    expect(url).toBe('/api/whatsapp/send')
    expect(init.method).toBe('POST')
    expect(init.credentials).toBe('same-origin')
    expect(JSON.parse(init.body)).toEqual({
      conversation_id: 'conv-1',
      message_type: 'text',
      content_text: 'I will check the quotations.',
    })
    expect(sw.shown[0].title).toContain('Reply sent')
  })

  it('shows a Retry notification when sending fails, and retry resends the same text', async () => {
    let calls = 0
    const sw = loadSw({
      fetchImpl: async () => {
        calls++
        return calls === 1
          ? { ok: false, status: 500, json: async () => ({ error: 'Meta down' }) }
          : { ok: true, status: 200, json: async () => ({}) }
      },
    })
    await fire(sw.handlers.notificationclick, { action: 'reply', reply: 'Hello', notification: { data, close } })
    expect(sw.shown[0].title).toBe('Reply NOT sent')
    expect(String(sw.shown[0].options.body)).toContain('Meta down')
    const retryData = sw.shown[0].options.data
    await fire(sw.handlers.notificationclick, { action: 'retry', notification: { data: retryData, close } })
    expect(calls).toBe(2)
    expect(sw.shown[1].title).toContain('Reply sent')
  })

  it('explains an expired session and a lost connection', async () => {
    const a = loadSw({ fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })
    await fire(a.handlers.notificationclick, { action: 'reply', reply: 'x', notification: { data, close } })
    expect(String(a.shown[0].options.body)).toContain('Session expired')
    const b = loadSw({ fetchImpl: async () => { throw new Error('offline') } })
    await fire(b.handlers.notificationclick, { action: 'reply', reply: 'x', notification: { data, close } })
    expect(String(b.shown[0].options.body)).toContain('No connection')
  })

  it('opens the chat when the browser gives no inline text (fallback) or on Open chat', async () => {
    const sw = loadSw()
    await fire(sw.handlers.notificationclick, { action: 'reply', notification: { data, close } })
    expect(sw.fetchMock).not.toHaveBeenCalled()
    expect(sw.openWindow).toHaveBeenCalledWith('https://wa.example.com/inbox?c=conv-1')
    const sw2 = loadSw({ windows: [{ url: 'https://wa.example.com/dashboard', visibilityState: 'hidden' }] })
    await fire(sw2.handlers.notificationclick, { action: 'open', notification: { data, close } })
    expect(sw2.focus).toHaveBeenCalled()
    expect(sw2.navigate).toHaveBeenCalledWith('https://wa.example.com/inbox?c=conv-1')
  })
})

describe('service worker: self-repair when the browser rotates the registration', () => {
  it('re-subscribes with the server key and sends the new subscription to the server', async () => {
    const subscribe = vi.fn(async (_opts: unknown) => ({ toJSON: () => ({ endpoint: 'https://push.example/new', keys: { p256dh: 'k', auth: 'a' } }) }))
    const fetchImpl = vi.fn(async (url: unknown, _init?: unknown) =>
      String(url).includes('public-key')
        ? { ok: true, status: 200, json: async () => ({ configured: true, publicKey: 'BAUG' }) }
        : { ok: true, status: 200, json: async () => ({}) },
    )
    const sw = loadSw({ subscribe, fetchImpl })
    await fire(sw.handlers.pushsubscriptionchange, {})
    expect(subscribe).toHaveBeenCalledTimes(1)
    const opts = subscribe.mock.calls[0][0] as { userVisibleOnly: boolean; applicationServerKey: Uint8Array }
    expect(opts.userVisibleOnly).toBe(true)
    expect(opts.applicationServerKey).toBeInstanceOf(Uint8Array)
    const post = fetchImpl.mock.calls.find((c) => String(c[0]).includes('/api/push/subscribe'))!
    expect(JSON.parse((post[1] as { body: string }).body).subscription.endpoint).toBe('https://push.example/new')
  })
  it('does nothing (and does not throw) when push is not configured or the user is signed out', async () => {
    const subscribe = vi.fn(async (_opts: unknown) => ({}))
    const sw = loadSw({ subscribe, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({}) }) })
    await expect(fire(sw.handlers.pushsubscriptionchange, {})).resolves.toBeUndefined()
    expect(subscribe).not.toHaveBeenCalled()
  })
})
