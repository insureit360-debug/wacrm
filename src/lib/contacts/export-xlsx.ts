import ExcelJS from 'exceljs'
import { REPORT_TZ, dateInTz } from './date-range'

/**
 * Excel export in the exact column layout the business uses:
 *
 *   name | phone | (blank) | phone with 91 | FOLLOWUP DATE | Tags | Created | DATE
 *
 *  - phone          +919790045369
 *  - (blank column) the word "Created" on every row
 *  - phone with 91  919790045369 (10-digit numbers get 91 added)
 *  - FOLLOWUP DATE  earliest pending follow-up date (blank if none)
 *  - Tags           left empty (manual column, as in the original sheet)
 *  - Created        the contact's WACRM tag(s), filled with the tag colour
 *  - DATE           the date the contact was added (India date)
 */
export interface ExportContact {
  name: string | null
  phone: string
  /** Earliest pending follow-up, YYYY-MM-DD, or null. */
  followupDate: string | null
  tags: Array<{ name: string; color?: string | null }>
  createdAt: string // ISO instant
}

export const EXPORT_HEADERS = [
  'name',
  'phone',
  '',
  'phone with 91',
  'FOLLOWUP DATE',
  'Tags',
  'Created',
  'DATE',
] as const

const DATE_FMT = 'mmm d, yyyy'
const DEFAULT_TAG_FILL = '8B5CF6' // WACRM purple

/** digits only; a bare 10-digit Indian mobile gets the 91 country code. */
export function phoneWith91(phone: string): string {
  let digits = (phone ?? '').replace(/\D/g, '')
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1)
  if (digits.length === 10) digits = `91${digits}`
  return digits
}

export function plusPhone(phone: string): string {
  const d = phoneWith91(phone)
  return d ? `+${d}` : ''
}

function hex6(color: string | null | undefined): string {
  const c = (color ?? '').replace('#', '')
  return /^[0-9a-fA-F]{6}$/.test(c) ? c.toUpperCase() : DEFAULT_TAG_FILL
}

function readableText(fillHex: string): string {
  const r = parseInt(fillHex.slice(0, 2), 16)
  const g = parseInt(fillHex.slice(2, 4), 16)
  const b = parseInt(fillHex.slice(4, 6), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 > 150 ? 'FF000000' : 'FFFFFFFF'
}

/** A calendar date as an Excel date cell value (no time-zone drift). */
function dateCell(iso: string): Date {
  const [y, m, d] = iso.split('-').map(Number)
  return new Date(Date.UTC(y, m - 1, d))
}

export async function buildContactsWorkbook(
  contacts: ExportContact[],
  tz: string = REPORT_TZ,
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  wb.creator = 'WACRM'
  const ws = wb.addWorksheet('Contacts', { views: [{ state: 'frozen', ySplit: 1 }] })

  ws.columns = [
    { width: 28 }, // name
    { width: 18 }, // phone
    { width: 12 }, // blank header
    { width: 18 }, // phone with 91
    { width: 16 }, // FOLLOWUP DATE
    { width: 18 }, // Tags
    { width: 24 }, // Created
    { width: 14 }, // DATE
  ]

  const header = ws.addRow([...EXPORT_HEADERS])
  header.font = { bold: true }
  header.alignment = { horizontal: 'center', vertical: 'middle' }
  header.eachCell({ includeEmpty: true }, (cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF3F3F3' } }
    cell.border = { bottom: { style: 'thin', color: { argb: 'FFBBBBBB' } } }
  })

  for (const c of contacts) {
    const with91 = phoneWith91(c.phone)
    const row = ws.addRow([
      c.name ?? '',
      plusPhone(c.phone),
      'Created',
      with91 ? Number(with91) : '',
      c.followupDate ? dateCell(c.followupDate) : null,
      null,
      c.tags.map((t) => t.name).join(', '),
      dateCell(dateInTz(c.createdAt, tz)),
    ])
    row.getCell(4).numFmt = '0'
    row.getCell(4).alignment = { horizontal: 'right' }
    row.getCell(5).numFmt = DATE_FMT
    row.getCell(5).alignment = { horizontal: 'right' }
    row.getCell(8).numFmt = DATE_FMT
    row.getCell(8).alignment = { horizontal: 'right' }
    if (c.tags.length > 0) {
      const fill = hex6(c.tags[0].color)
      const cell = row.getCell(7)
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: `FF${fill}` } }
      cell.font = { color: { argb: readableText(fill) } }
    }
  }

  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: 8 } }
  return Buffer.from(await wb.xlsx.writeBuffer())
}
