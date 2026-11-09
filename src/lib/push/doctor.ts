// Pure logic for the Settings "notification checker": turns what the browser
// and the server report into an ordered list of pass/fail checks plus one
// plain-language verdict. No browser or server APIs here, so it is unit-tested.

export interface ClientFacts {
  supported: boolean
  permission: NotificationPermission | 'unsupported'
  browser: 'brave' | 'firefox' | 'edge' | 'chrome' | 'safari' | 'other'
  standalone: boolean
  isAndroid: boolean
  isIOS: boolean
  isXiaomiLike: boolean
  swState: 'none' | 'installing' | 'waiting' | 'active'
  hasSubscription: boolean
  endpointHash: string | null
  /** null = unknown (no subscription or no server key yet). */
  keyMatchesServer: boolean | null
}

export interface ServerFacts {
  vapid: { configured: boolean; ok: boolean; error?: string }
  devices: Array<{ endpointHash: string }>
  lastPush: { at: string; source: string; sent: number; subscriptions: number; errors: string[] } | null
}

export type CheckId =
  | 'server_keys'
  | 'browser_support'
  | 'permission'
  | 'service_worker'
  | 'subscription'
  | 'key_match'
  | 'server_knows_device'
  | 'last_push'

export type CheckState = 'ok' | 'fail' | 'warn' | 'skip'

export interface Check {
  id: CheckId
  state: CheckState
  /** Machine code for the explanation text (translated in the UI). */
  code: string
  /** Extra text (e.g. the server's own error message). */
  detail?: string
  /** Which button fixes it. */
  fix?: 'turn_on' | 'repair' | 'none'
}

export interface Diagnosis {
  checks: Check[]
  working: boolean
  /** First failing check, if any. */
  problem: Check | null
}

export function evaluateChecks(client: ClientFacts, server: ServerFacts): Diagnosis {
  const checks: Check[] = []

  // 1. Server keys
  if (!server.vapid.configured) {
    checks.push({ id: 'server_keys', state: 'fail', code: 'not_configured', fix: 'none' })
  } else if (!server.vapid.ok) {
    checks.push({ id: 'server_keys', state: 'fail', code: 'invalid', detail: server.vapid.error, fix: 'none' })
  } else {
    checks.push({ id: 'server_keys', state: 'ok', code: 'ok' })
  }

  // 2. Browser support (iPhone needs the app added to the home screen first)
  if (!client.supported) {
    const iosNeedsInstall = client.isIOS && !client.standalone
    checks.push({
      id: 'browser_support',
      state: 'fail',
      code: iosNeedsInstall ? 'ios_install' : 'unsupported',
      fix: 'none',
    })
  } else {
    checks.push({ id: 'browser_support', state: 'ok', code: 'ok' })
  }

  // 3. Permission
  if (client.permission === 'granted') {
    checks.push({ id: 'permission', state: 'ok', code: 'ok' })
  } else if (client.permission === 'denied') {
    checks.push({ id: 'permission', state: 'fail', code: 'blocked', fix: 'none' })
  } else {
    checks.push({ id: 'permission', state: 'fail', code: 'ask', fix: 'turn_on' })
  }

  // 4. Service worker
  checks.push(
    client.swState === 'active'
      ? { id: 'service_worker', state: 'ok', code: 'ok' }
      : { id: 'service_worker', state: 'fail', code: 'sw_missing', fix: 'turn_on' },
  )

  // 5. Browser registration with the push service
  checks.push(
    client.hasSubscription
      ? { id: 'subscription', state: 'ok', code: 'ok' }
      : { id: 'subscription', state: 'fail', code: 'no_subscription', fix: 'turn_on' },
  )

  // 6. Registration made with the SAME keys the server uses now
  if (client.hasSubscription && client.keyMatchesServer === false) {
    checks.push({ id: 'key_match', state: 'fail', code: 'key_mismatch', fix: 'repair' })
  } else if (client.hasSubscription && client.keyMatchesServer === true) {
    checks.push({ id: 'key_match', state: 'ok', code: 'ok' })
  } else {
    checks.push({ id: 'key_match', state: 'skip', code: 'skip' })
  }

  // 7. Server has this device on file
  if (!client.hasSubscription || !client.endpointHash) {
    checks.push({ id: 'server_knows_device', state: 'skip', code: 'skip' })
  } else if (server.devices.some((d) => d.endpointHash === client.endpointHash)) {
    checks.push({ id: 'server_knows_device', state: 'ok', code: 'ok' })
  } else {
    checks.push({ id: 'server_knows_device', state: 'fail', code: 'server_missing', fix: 'repair' })
  }

  // 8. What happened the last time the server tried to push
  const lp = server.lastPush
  if (!lp) {
    checks.push({ id: 'last_push', state: 'skip', code: 'none_yet' })
  } else if (lp.sent > 0 && lp.errors.length === 0) {
    checks.push({ id: 'last_push', state: 'ok', code: 'last_ok' })
  } else if (lp.subscriptions === 0) {
    checks.push({ id: 'last_push', state: 'fail', code: 'last_no_devices', fix: 'repair' })
  } else {
    checks.push({ id: 'last_push', state: 'fail', code: 'last_error', detail: lp.errors[0], fix: 'repair' })
  }

  const problem = checks.find((c) => c.state === 'fail') ?? null
  return { checks, working: problem === null, problem }
}
