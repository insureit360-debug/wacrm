import { addDaysIso } from '@/lib/followups/dates'

/**
 * Time zone used for "added on <date>" filters and the Excel DATE column.
 * Contacts are stored in UTC; a calendar day is cut in THIS zone so
 * "11 Oct" means 11 Oct in India, not 11 Oct in London.
 */
export const REPORT_TZ = 'Asia/Kolkata'

const ISO = /^\d{4}-\d{2}-\d{2}$/

function offsetMinutes(instantMs: number, tz: string): number {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(new Date(instantMs))
      .map((p) => [p.type, p.value]),
  )
  const asUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second)
  return Math.round((asUtc - Math.floor(instantMs / 1000) * 1000) / 60_000)
}

/** The exact instant (ISO, UTC) at which calendar day `date` starts in `tz`. */
export function zonedDayStartIso(date: string, tz: string = REPORT_TZ): string {
  if (!ISO.test(date)) throw new Error(`Bad date: ${date}`)
  const [y, m, d] = date.split('-').map(Number)
  const guess = Date.UTC(y, m - 1, d)
  const off1 = offsetMinutes(guess, tz)
  let ms = guess - off1 * 60_000
  const off2 = offsetMinutes(ms, tz)
  if (off2 !== off1) ms = guess - off2 * 60_000
  return new Date(ms).toISOString()
}

/** `[from, to)` instants covering whole calendar days fromDate..toDate inclusive. */
export function rangeBounds(
  fromDate: string,
  toDate: string,
  tz: string = REPORT_TZ,
): { fromIso: string | null; toIsoExclusive: string | null } {
  return {
    fromIso: ISO.test(fromDate) ? zonedDayStartIso(fromDate, tz) : null,
    toIsoExclusive: ISO.test(toDate) ? zonedDayStartIso(addDaysIso(toDate, 1), tz) : null,
  }
}

/** Today's calendar date in `tz`, as YYYY-MM-DD. */
export function todayInTz(tz: string = REPORT_TZ, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now)
}

/** The calendar date (in `tz`) on which `instantIso` falls. */
export function dateInTz(instantIso: string, tz: string = REPORT_TZ): string {
  return todayInTz(tz, new Date(instantIso))
}

export type DatePreset = 'today' | 'yesterday' | 'last7' | 'last30' | 'thisMonth'

export function presetRange(preset: DatePreset, today: string): { from: string; to: string } {
  switch (preset) {
    case 'today':
      return { from: today, to: today }
    case 'yesterday': {
      const y = addDaysIso(today, -1)
      return { from: y, to: y }
    }
    case 'last7':
      return { from: addDaysIso(today, -6), to: today }
    case 'last30':
      return { from: addDaysIso(today, -29), to: today }
    case 'thisMonth':
      return { from: `${today.slice(0, 8)}01`, to: today }
  }
}
