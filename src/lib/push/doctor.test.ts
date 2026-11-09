import { describe, expect, it } from 'vitest'
import { evaluateChecks, type ClientFacts, type ServerFacts } from './doctor'

const goodClient: ClientFacts = {
  supported: true, permission: 'granted', browser: 'chrome', standalone: true, isAndroid: true, isIOS: false,
  isXiaomiLike: false, swState: 'active', hasSubscription: true, endpointHash: 'abc', keyMatchesServer: true,
}
const goodServer: ServerFacts = {
  vapid: { configured: true, ok: true },
  devices: [{ endpointHash: 'abc' }],
  lastPush: { at: '2026-11-07T10:00:00Z', source: 'message', sent: 1, subscriptions: 1, errors: [] },
}
const run = (c: Partial<ClientFacts> = {}, s: Partial<ServerFacts> = {}) =>
  evaluateChecks({ ...goodClient, ...c }, { ...goodServer, ...s })

describe('evaluateChecks', () => {
  it('everything fine -> working, no problem', () => {
    const d = run()
    expect(d.working).toBe(true)
    expect(d.problem).toBeNull()
    expect(d.checks.map((c) => c.state)).toEqual(Array(8).fill('ok'))
  })
  it('missing server keys is reported first', () => {
    const d = run({}, { vapid: { configured: false, ok: false } })
    expect(d.problem).toMatchObject({ id: 'server_keys', code: 'not_configured' })
  })
  it('invalid keys carry the server message', () => {
    const d = run({}, { vapid: { configured: true, ok: false, error: 'different pairs' } })
    expect(d.problem).toMatchObject({ id: 'server_keys', code: 'invalid', detail: 'different pairs' })
  })
  it('blocked permission vs not yet asked', () => {
    expect(run({ permission: 'denied' }).problem).toMatchObject({ id: 'permission', code: 'blocked', fix: 'none' })
    expect(run({ permission: 'default' }).problem).toMatchObject({ id: 'permission', code: 'ask', fix: 'turn_on' })
  })
  it('iPhone outside the home-screen app gets the install hint', () => {
    const d = run({ supported: false, isIOS: true, standalone: false, permission: 'unsupported' })
    expect(d.problem).toMatchObject({ id: 'browser_support', code: 'ios_install' })
  })
  it('no service worker / no subscription ask to turn on', () => {
    expect(run({ swState: 'none' }).checks.find((c) => c.id === 'service_worker')).toMatchObject({ state: 'fail', fix: 'turn_on' })
    const d = run({ hasSubscription: false, endpointHash: null, keyMatchesServer: null })
    expect(d.checks.find((c) => c.id === 'subscription')).toMatchObject({ state: 'fail' })
    expect(d.checks.find((c) => c.id === 'server_knows_device')?.state).toBe('skip')
  })
  it('registration made with old keys -> repair', () => {
    expect(run({ keyMatchesServer: false }).problem).toMatchObject({ id: 'key_match', fix: 'repair' })
  })
  it('device missing on the server -> repair', () => {
    expect(run({}, { devices: [] }).problem).toMatchObject({ id: 'server_knows_device', code: 'server_missing', fix: 'repair' })
  })
  it('last push: no attempt yet is neutral, errors are surfaced, zero devices explained', () => {
    expect(run({}, { lastPush: null }).working).toBe(true)
    const e = run({}, { lastPush: { at: 'x', source: 'message', sent: 0, subscriptions: 1, errors: ['Push service refused (403): invalid JWT'] } })
    expect(e.problem).toMatchObject({ id: 'last_push', code: 'last_error', detail: 'Push service refused (403): invalid JWT' })
    const n = run({}, { lastPush: { at: 'x', source: 'message', sent: 0, subscriptions: 0, errors: [] } })
    expect(n.problem).toMatchObject({ id: 'last_push', code: 'last_no_devices' })
  })
})

import en from '../../../messages/en.json'
import es from '../../../messages/es.json'
import pt from '../../../messages/pt.json'
import ko from '../../../messages/ko.json'

describe('every message the checker can show exists in all languages', () => {
  const IDS = ['server_keys', 'browser_support', 'permission', 'service_worker', 'subscription', 'key_match', 'server_knows_device', 'last_push']
  const CODES = ['not_configured', 'invalid', 'unsupported', 'ios_install', 'blocked', 'ask', 'sw_missing', 'no_subscription', 'key_mismatch', 'server_missing', 'last_ok', 'last_error', 'last_no_devices', 'none_yet']
  const STATIC = ['title', 'intro', 'checking', 'statusLoadFailed', 'verdictOk', 'verdictFail', 'turnOn', 'repair', 'sendTest', 'recheck', 'turnOff', 'enabledToast', 'enableFailed', 'testOk', 'testFailed', 'testNoDevice', 'tipBrave', 'tipInstall', 'tipIosInstall', 'tipXiaomi', 'phoneSettingsTitle', 'phoneSettingsBody', 'devicesTitle', 'thisDevice', 'lastSeen', 'removeDevice', 'removeFailed']
  const keys = [...IDS.map((i) => `label_${i}`), ...CODES.map((c) => `explain_${c}`), ...STATIC]
  for (const [name, msgs] of Object.entries({ en, es, pt, ko })) {
    it(`${name} has all ${keys.length} keys`, () => {
      const ns = (msgs as unknown as { PushDoctor: Record<string, string> }).PushDoctor
      const missing = keys.filter((k) => typeof ns[k] !== 'string')
      expect(missing).toEqual([])
    })
  }
  it('every check code the logic can emit has an explanation', () => {
    // Collect codes by running a spread of scenarios through the real evaluator.
    const emitted = new Set<string>()
    const cs: Array<Partial<ClientFacts>> = [{}, { supported: false, isIOS: true, standalone: false }, { supported: false }, { permission: 'denied' }, { permission: 'default' }, { swState: 'none' }, { hasSubscription: false, endpointHash: null, keyMatchesServer: null }, { keyMatchesServer: false }]
    const ss: Array<Partial<ServerFacts>> = [{}, { vapid: { configured: false, ok: false } }, { vapid: { configured: true, ok: false, error: 'x' } }, { devices: [] }, { lastPush: null }, { lastPush: { at: 'x', source: 'm', sent: 0, subscriptions: 1, errors: ['e'] } }, { lastPush: { at: 'x', source: 'm', sent: 0, subscriptions: 0, errors: [] } }]
    for (const c of cs) for (const s of ss) for (const ch of evaluateChecks({ ...goodClient, ...c }, { ...goodServer, ...s }).checks) if (ch.state !== 'skip' && ch.code !== 'ok') emitted.add(ch.code)
    for (const code of emitted) expect(CODES).toContain(code)
  })
})
