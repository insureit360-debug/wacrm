import webpush from 'web-push'
import { createECDH, createHash } from 'node:crypto'
import { createClient } from '@supabase/supabase-js'
import type { PushPayload } from './payload'

// Server-only. Reads VAPID keys at call time (not import time) so a
// missing key never crashes the build or the webhook.

// Untyped (like the webhook route's client): no generated DB types in this repo.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _admin: any = null
function admin() {
  if (!_admin) {
    _admin = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _admin
}

export function getVapid(): { publicKey: string; privateKey: string; subject: string } | null {
  const publicKey = process.env.VAPID_PUBLIC_KEY
  const privateKey = process.env.VAPID_PRIVATE_KEY
  if (!publicKey || !privateKey) return null
  return {
    publicKey,
    privateKey,
    subject: process.env.VAPID_SUBJECT || 'mailto:admin@example.com',
  }
}

export function isPushConfigured(): boolean {
  return getVapid() !== null
}

export interface PushAttempt {
  at: string
  source: string
  sent: number
  subscriptions: number
  errors: string[]
}

// Remembered in memory (per server process) so the Settings checker can show
// whether the last real customer message actually produced a push.
let lastAttempt: PushAttempt | null = null
export function getLastPushAttempt(): PushAttempt | null {
  return lastAttempt
}

const b64url = (s: string) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')

export interface VapidCheck {
  configured: boolean
  ok: boolean
  error?: string
  /** First characters of the public key, to compare with the browser's registration. */
  publicKeyPrefix?: string
}

/**
 * Verifies the VAPID settings end to end WITHOUT sending anything: both keys
 * present, correct size, a matching pair, and a valid subject. Never returns
 * the private key.
 */
export function checkVapid(): VapidCheck {
  const v = getVapid()
  if (!v) return { configured: false, ok: false, error: 'VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY are not set' }
  const prefix = v.publicKey.slice(0, 10)
  const fail = (error: string): VapidCheck => ({ configured: true, ok: false, error, publicKeyPrefix: prefix })
  try {
    const pub = b64url(v.publicKey)
    const priv = b64url(v.privateKey)
    if (pub.length !== 65 || pub[0] !== 4) return fail('VAPID_PUBLIC_KEY is not a valid key (copy the whole "Public Key" line)')
    if (priv.length !== 32) return fail('VAPID_PRIVATE_KEY is not a valid key (copy the whole "Private Key" line)')
    const ecdh = createECDH('prime256v1')
    ecdh.setPrivateKey(priv)
    if (!ecdh.getPublicKey().equals(pub)) {
      return fail('VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are from different pairs. Generate ONE new pair and paste both.')
    }
    if (!/^mailto:.+@.+\..+/.test(v.subject) && !/^https:\/\/.+/.test(v.subject)) {
      return fail('VAPID_SUBJECT must look like mailto:you@example.com')
    }
    webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey)
    return { configured: true, ok: true, publicKeyPrefix: prefix }
  } catch (err) {
    return fail((err as Error).message)
  }
}

export interface DeviceInfo {
  id: string
  endpointHash: string
  endpointHost: string
  userAgent: string | null
  createdAt: string
  lastSeenAt: string
}

/** sha256 of the endpoint, first 16 hex chars (the browser computes the same). */
export function endpointHash(endpoint: string): string {
  return createHash('sha256').update(endpoint).digest('hex').slice(0, 16)
}

export async function listDevices(accountId: string, userId: string): Promise<DeviceInfo[]> {
  const { data } = await admin()
    .from('push_subscriptions')
    .select('id, endpoint, user_agent, created_at, last_seen_at')
    .eq('account_id', accountId)
    .eq('user_id', userId)
    .order('last_seen_at', { ascending: false })
  return ((data ?? []) as Array<{ id: string; endpoint: string; user_agent: string | null; created_at: string; last_seen_at: string }>).map((r) => {
    let host = ''
    try {
      host = new URL(r.endpoint).host
    } catch {
      /* ignore */
    }
    return {
      id: r.id,
      endpointHash: endpointHash(r.endpoint),
      endpointHost: host,
      userAgent: r.user_agent,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
    }
  })
}

export async function deleteDeviceById(userId: string, id: string): Promise<void> {
  await admin().from('push_subscriptions').delete().eq('user_id', userId).eq('id', id)
}

export interface PushResult {
  sent: number
  removed: number
  configured: boolean
  /** How many registered devices the account has. */
  subscriptions: number
  /** Human-readable reasons (no secrets) when something went wrong. */
  errors: string[]
}

interface SubRow {
  id: string
  endpoint: string
  p256dh: string
  auth: string
}

/**
 * Sends `payload` to every push subscription in `accountId` (optionally
 * just one user's). Never throws; dead subscriptions (404/410) are pruned.
 * Returns how many were delivered to the push service.
 */
export async function sendPushToAccount(
  accountId: string,
  payload: PushPayload | Record<string, unknown>,
  opts: { userId?: string; source?: string } = {},
): Promise<PushResult> {
  const source = opts.source ?? 'message'
  const record = (r: PushResult): PushResult => {
    lastAttempt = {
      at: new Date().toISOString(),
      source,
      sent: r.sent,
      subscriptions: r.subscriptions,
      errors: r.errors.slice(0, 3),
    }
    return r
  }
  const vapid = getVapid()
  if (!vapid) return record({ sent: 0, removed: 0, configured: false, subscriptions: 0, errors: [] })
  const errors: string[] = []
  try {
    try {
      webpush.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
    } catch (err) {
      // Messages from web-push never contain the key values themselves.
      const msg = `VAPID settings invalid: ${(err as Error).message}`
      console.error('[push]', msg)
      return record({ sent: 0, removed: 0, configured: true, subscriptions: 0, errors: [msg] })
    }

    let q = admin()
      .from('push_subscriptions')
      .select('id, endpoint, p256dh, auth')
      .eq('account_id', accountId)
    if (opts.userId) q = q.eq('user_id', opts.userId)
    const { data, error } = await q
    if (error || !data) {
      const msg = `Could not read push_subscriptions: ${error?.message ?? 'unknown'} (was migration 060 run?)`
      console.error('[push]', msg)
      return record({ sent: 0, removed: 0, configured: true, subscriptions: 0, errors: [msg] })
    }

    const body = JSON.stringify(payload)
    const dead: string[] = []
    let sent = 0
    await Promise.all(
      (data as unknown as SubRow[]).map(async (s) => {
        try {
          await webpush.sendNotification(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            body,
            { TTL: 3600, urgency: 'high', timeout: 8000 },
          )
          sent++
        } catch (err) {
          const status = (err as { statusCode?: number }).statusCode
          if (status === 404 || status === 410) dead.push(s.id)
          else {
            const body = String((err as { body?: unknown }).body ?? '').slice(0, 160)
            const msg = `Push service refused (${status ?? 'network'}): ${body || (err as Error).message}`
            errors.push(msg)
            console.error('[push]', msg)
          }
        }
      }),
    )
    if (dead.length) await admin().from('push_subscriptions').delete().in('id', dead)
    return record({
      sent,
      removed: dead.length,
      configured: true,
      subscriptions: (data as unknown[]).length,
      errors,
    })
  } catch (err) {
    const msg = `Unexpected failure: ${(err as Error).message}`
    console.error('[push]', msg)
    return record({ sent: 0, removed: 0, configured: true, subscriptions: 0, errors: [msg] })
  }
}

/** Upsert used by the subscribe route (after it authenticated the caller). */
export async function saveSubscription(args: {
  accountId: string
  userId: string
  endpoint: string
  p256dh: string
  auth: string
  userAgent: string | null
}): Promise<boolean> {
  const { error } = await admin()
    .from('push_subscriptions')
    .upsert(
      {
        account_id: args.accountId,
        user_id: args.userId,
        endpoint: args.endpoint,
        p256dh: args.p256dh,
        auth: args.auth,
        user_agent: args.userAgent?.slice(0, 300) ?? null,
        last_seen_at: new Date().toISOString(),
      },
      { onConflict: 'endpoint' },
    )
  if (error) console.error('[push] save subscription failed:', error.message)
  return !error
}

export async function deleteSubscription(userId: string, endpoint: string): Promise<void> {
  await admin().from('push_subscriptions').delete().eq('user_id', userId).eq('endpoint', endpoint)
}

/**
 * Called from the inbound WhatsApp webhook. Bounded by a timeout and
 * wrapped so a push problem can never fail or delay message processing.
 */
export async function notifyInboundPush(args: {
  accountId: string
  payload: PushPayload
}): Promise<void> {
  if (!isPushConfigured()) return
  try {
    await Promise.race([
      sendPushToAccount(args.accountId, args.payload, { source: 'message' }),
      new Promise((resolve) => setTimeout(resolve, 10_000)),
    ])
  } catch {
    /* never throw into the webhook */
  }
}
