import { describe, expect, it } from 'vitest'
import { dateInTz, presetRange, rangeBounds, todayInTz, zonedDayStartIso } from './date-range'

describe('date-range (India day boundaries)', () => {
  it('a day starts at 18:30 UTC the previous evening in IST', () => {
    expect(zonedDayStartIso('2026-10-11', 'Asia/Kolkata')).toBe('2026-10-10T18:30:00.000Z')
    expect(zonedDayStartIso('2026-01-01', 'Asia/Kolkata')).toBe('2025-12-31T18:30:00.000Z')
  })
  it('handles zones with daylight saving', () => {
    expect(zonedDayStartIso('2026-07-01', 'Europe/London')).toBe('2026-06-30T23:00:00.000Z')
    expect(zonedDayStartIso('2026-12-01', 'Europe/London')).toBe('2026-12-01T00:00:00.000Z')
  })
  it('range is [start of from-day, start of day AFTER to-day)', () => {
    expect(rangeBounds('2026-10-11', '2026-10-11')).toEqual({
      fromIso: '2026-10-10T18:30:00.000Z',
      toIsoExclusive: '2026-10-11T18:30:00.000Z',
    })
    expect(rangeBounds('', '2026-10-11')).toEqual({ fromIso: null, toIsoExclusive: '2026-10-11T18:30:00.000Z' })
    expect(rangeBounds('', '')).toEqual({ fromIso: null, toIsoExclusive: null })
  })
  it('maps an instant to its India calendar date (late-night UTC is already tomorrow in IST)', () => {
    expect(dateInTz('2026-10-10T20:00:00Z')).toBe('2026-10-11')
    expect(dateInTz('2026-10-11T17:00:00Z')).toBe('2026-10-11')
    expect(dateInTz('2026-10-11T18:30:00Z')).toBe('2026-10-12')
  })
  it('today in IST', () => {
    expect(todayInTz('Asia/Kolkata', new Date('2026-11-03T20:00:00Z'))).toBe('2026-11-04')
  })
  it('presets', () => {
    expect(presetRange('today', '2026-11-03')).toEqual({ from: '2026-11-03', to: '2026-11-03' })
    expect(presetRange('yesterday', '2026-11-03')).toEqual({ from: '2026-11-02', to: '2026-11-02' })
    expect(presetRange('last7', '2026-11-03')).toEqual({ from: '2026-10-28', to: '2026-11-03' })
    expect(presetRange('last30', '2026-11-03')).toEqual({ from: '2026-10-05', to: '2026-11-03' })
    expect(presetRange('thisMonth', '2026-11-03')).toEqual({ from: '2026-11-01', to: '2026-11-03' })
  })
})
