import type { ClientFacts } from './doctor'
// Browser-only helpers for Web Push opt-in. Never import from server code.

export const PUSH_PREF_KEY = 'wacrm:push-enabled'
export const PUSH_CHANGE_EVENT = 'wacrm:push-change'

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  )
}

export function readPushPref(): boolean {
  if (typeof window === 'undefined') return false
  try {
    return window.localStorage.getItem(PUSH_PREF_KEY) === '1'
  } catch {
    return false
  }
}

function writePushPref(enabled: boolean): void {
  try {
    if (enabled) window.localStorage.setItem(PUSH_PREF_KEY, '1')
    else window.localStorage.removeItem(PUSH_PREF_KEY)
  } catch {
    /* best effort */
  }
  window.dispatchEvent(new Event(PUSH_CHANGE_EVENT))
}

export function subscribePushPref(onChange: () => void): () => void {
  if (typeof window === 'undefined') return () => {}
  const onStorage = (e: StorageEvent) => {
    if (e.key === null || e.key === PUSH_PREF_KEY) onChange()
  }
  window.addEventListener(PUSH_CHANGE_EVENT, onChange)
  window.addEventListener('storage', onStorage)
  return () => {
    window.removeEventListener(PUSH_CHANGE_EVENT, onChange)
    window.removeEventListener('storage', onStorage)
  }
}

export function urlBase64ToUint8Array(base64: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64.length % 4)) % 4)
  const raw = atob((base64 + padding).replace(/-/g, '+').replace(/_/g, '/'))
  const out = new Uint8Array(new ArrayBuffer(raw.length))
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i)
  return out
}

export type EnablePushResult =
  | { ok: true }
  | {
      ok: false
      reason: 'unsupported' | 'denied' | 'not_configured' | 'error'
      /** The browser's or server's own error text, so a failure is never a mystery. */
      detail?: string
    }

export function sameKey(current: ArrayBuffer | null, wanted: Uint8Array): boolean {
  if (!current) return false
  const a = new Uint8Array(current)
  if (a.length !== wanted.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== wanted[i]) return false
  return true
}

async function ensureSubscription(): Promise<PushSubscription | null> {
  const keyRes = await fetch('/api/push/public-key', { credentials: 'same-origin' })
  if (!keyRes.ok) return null
  const key = (await keyRes.json()) as { configured: boolean; publicKey: string | null }
  if (!key.configured || !key.publicKey) return null

  const reg = await navigator.serviceWorker.register('/sw.js')
  await navigator.serviceWorker.ready
  const wanted = urlBase64ToUint8Array(key.publicKey)
  let sub = await reg.pushManager.getSubscription()
  // A subscription made with an older/different VAPID key is rejected by the
  // push service. After keys are rotated, drop it and subscribe again.
  if (sub && !sameKey(sub.options.applicationServerKey, wanted)) {
    await sub.unsubscribe()
    sub = null
  }
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: wanted,
    })
  }
  return sub
}

async function postSubscription(sub: PushSubscription): Promise<boolean> {
  const res = await fetch('/api/push/subscribe', {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ subscription: sub.toJSON() }),
  })
  return res.ok
}

export async function enablePush(opts: { force?: boolean } = {}): Promise<EnablePushResult> {
  if (!isPushSupported()) return { ok: false, reason: 'unsupported' }
  try {
    let perm = Notification.permission
    if (perm === 'default') perm = await Notification.requestPermission()
    if (perm !== 'granted') return { ok: false, reason: 'denied' }

    const keyRes = await fetch('/api/push/public-key', { credentials: 'same-origin' })
    const key = keyRes.ok ? ((await keyRes.json()) as { configured: boolean }) : null
    if (!key || !key.configured) return { ok: false, reason: 'not_configured' }

    if (opts.force) {
      // Repair: throw away this browser's registration and start clean.
      const reg = await navigator.serviceWorker.getRegistration()
      const old = await reg?.pushManager.getSubscription()
      if (old) {
        await fetch('/api/push/unsubscribe', {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ endpoint: old.endpoint }),
        }).catch(() => {})
        await old.unsubscribe().catch(() => {})
      }
    }

    const sub = await ensureSubscription()
    if (!sub) return { ok: false, reason: 'error', detail: 'Could not create a push registration.' }
    if (!(await postSubscription(sub))) {
      return { ok: false, reason: 'error', detail: 'The server did not accept this device. Is migration 060 applied?' }
    }
    writePushPref(true)
    return { ok: true }
  } catch (err) {
    console.error('[push] enable failed:', err)
    const e = err as { name?: string; message?: string }
    return { ok: false, reason: 'error', detail: [e.name, e.message].filter(Boolean).join(': ') || String(err) }
  }
}

export async function disablePush(): Promise<void> {
  try {
    const reg = await navigator.serviceWorker.getRegistration('/sw.js')
    const sub = await reg?.pushManager.getSubscription()
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      }).catch(() => {})
      await sub.unsubscribe()
    }
  } finally {
    writePushPref(false)
  }
}

/** Re-registers this device on app load so an expired subscription heals itself. */
export async function syncPushSubscription(): Promise<void> {
  if (!isPushSupported() || !readPushPref() || Notification.permission !== 'granted') return
  try {
    const sub = await ensureSubscription()
    if (sub) await postSubscription(sub)
  } catch (err) {
    console.error('[push] sync failed:', err)
  }
}

export interface TestPushResult {
  sent: number
  configured: boolean
  subscriptions: number
  errors: string[]
}

export async function sendTestPush(): Promise<TestPushResult | null> {
  try {
    const res = await fetch('/api/push/test', { method: 'POST', credentials: 'same-origin' })
    if (!res.ok) return null
    return (await res.json()) as TestPushResult
  } catch {
    return null
  }
}

export function detectBrowser(
  ua: string,
  isBrave: boolean,
): 'brave' | 'firefox' | 'edge' | 'chrome' | 'safari' | 'other' {
  if (isBrave) return 'brave'
  if (/Firefox\//.test(ua)) return 'firefox'
  if (/Edg\//.test(ua)) return 'edge'
  if (/Chrome\/|CriOS\//.test(ua)) return 'chrome'
  if (/Safari\//.test(ua)) return 'safari'
  return 'other'
}

async function sha256Short(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, 16)
}

/** Facts about THIS browser/device, for the Settings notification checker. */
export async function diagnoseClient(serverPublicKey: string | null): Promise<ClientFacts> {
  const ua = typeof navigator !== 'undefined' ? navigator.userAgent : ''
  const braveApi = (navigator as unknown as { brave?: { isBrave?: () => Promise<boolean> } }).brave
  const isBrave = braveApi?.isBrave ? await braveApi.isBrave().catch(() => false) : false
  const supported = isPushSupported()
  const facts: ClientFacts = {
    supported,
    permission: 'Notification' in window ? Notification.permission : 'unsupported',
    browser: detectBrowser(ua, isBrave),
    standalone:
      window.matchMedia?.('(display-mode: standalone)').matches ||
      (navigator as unknown as { standalone?: boolean }).standalone === true,
    isAndroid: /Android/i.test(ua),
    isIOS: /iPhone|iPad|iPod/i.test(ua),
    isXiaomiLike: /MIUI|XiaoMi|Redmi|POCO|HyperOS|OPPO|Realme|vivo/i.test(ua),
    swState: 'none',
    hasSubscription: false,
    endpointHash: null,
    keyMatchesServer: null,
  }
  if (!supported) return facts
  try {
    const reg = await navigator.serviceWorker.getRegistration()
    if (reg) {
      facts.swState = reg.active ? 'active' : reg.waiting ? 'waiting' : reg.installing ? 'installing' : 'none'
      const sub = await reg.pushManager.getSubscription()
      if (sub) {
        facts.hasSubscription = true
        facts.endpointHash = await sha256Short(sub.endpoint)
        if (serverPublicKey) {
          facts.keyMatchesServer = sameKey(sub.options.applicationServerKey, urlBase64ToUint8Array(serverPublicKey))
        }
      }
    }
  } catch {
    /* leave defaults: the checks will report what is missing */
  }
  return facts
}

export interface PushStatusResponse {
  vapid: { configured: boolean; ok: boolean; error?: string; publicKeyPrefix?: string }
  devices: Array<{
    id: string
    endpointHash: string
    endpointHost: string
    userAgent: string | null
    createdAt: string
    lastSeenAt: string
  }>
  lastPush: { at: string; source: string; sent: number; subscriptions: number; errors: string[] } | null
  serverTime: string
}

export async function fetchPushStatus(): Promise<PushStatusResponse | null> {
  try {
    const res = await fetch('/api/push/status', { credentials: 'same-origin' })
    return res.ok ? ((await res.json()) as PushStatusResponse) : null
  } catch {
    return null
  }
}

export async function fetchServerPublicKey(): Promise<string | null> {
  try {
    const res = await fetch('/api/push/public-key', { credentials: 'same-origin' })
    if (!res.ok) return null
    const j = (await res.json()) as { publicKey: string | null }
    return j.publicKey
  } catch {
    return null
  }
}

export async function removeDeviceById(id: string): Promise<boolean> {
  try {
    const res = await fetch('/api/push/unsubscribe', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    })
    return res.ok
  } catch {
    return false
  }
}
