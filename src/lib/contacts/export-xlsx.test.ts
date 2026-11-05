import { describe, expect, it } from 'vitest'
import ExcelJS from 'exceljs'
import { EXPORT_HEADERS, buildContactsWorkbook, phoneWith91, plusPhone } from './export-xlsx'

async function read(buf: Buffer) {
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as ArrayBuffer)
  return wb.worksheets[0]
}

describe('phone helpers', () => {
  it('adds 91 to bare 10-digit numbers and keeps full numbers', () => {
    expect(phoneWith91('9790045369')).toBe('919790045369')
    expect(phoneWith91('09790045369')).toBe('919790045369')
    expect(phoneWith91('919790045369')).toBe('919790045369')
    expect(phoneWith91('+91 97900 45369')).toBe('919790045369')
    expect(plusPhone('919790045369')).toBe('+919790045369')
    expect(plusPhone('')).toBe('')
  })
})

describe('buildContactsWorkbook (matches the required sheet layout)', () => {
  it('has exactly the required header row', async () => {
    const ws = await read(await buildContactsWorkbook([]))
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((i) => String(ws.getRow(1).getCell(i).value ?? ''))).toEqual([...EXPORT_HEADERS])
    expect(ws.getRow(1).font?.bold).toBe(true)
  })

  it('writes the sample rows exactly (name, +phone, Created, phone with 91, tag colour, India date)', async () => {
    const ws = await read(
      await buildContactsWorkbook([
        {
          name: 'Sridhar',
          phone: '919790045369',
          followupDate: '2026-11-20',
          tags: [{ name: 'Quote Pending', color: '#8b5cf6' }],
          createdAt: '2026-10-10T20:00:00Z', // 11 Oct in India
        },
        { name: null, phone: '9787041101', followupDate: null, tags: [], createdAt: '2026-10-11T05:00:00Z' },
      ]),
    )
    const r = ws.getRow(2)
    expect(r.getCell(1).value).toBe('Sridhar')
    expect(r.getCell(2).value).toBe('+919790045369')
    expect(r.getCell(3).value).toBe('Created')
    expect(r.getCell(4).value).toBe(919790045369)
    expect((r.getCell(5).value as Date).toISOString().slice(0, 10)).toBe('2026-11-20')
    expect(r.getCell(5).numFmt).toBe('mmm d, yyyy')
    expect(r.getCell(6).value ?? null).toBeNull() // Tags column left empty
    expect(r.getCell(7).value).toBe('Quote Pending')
    expect(r.getCell(7).fill).toMatchObject({ fgColor: { argb: 'FF8B5CF6' } })
    expect((r.getCell(8).value as Date).toISOString().slice(0, 10)).toBe('2026-10-11')
    expect(r.getCell(8).numFmt).toBe('mmm d, yyyy')

    const r2 = ws.getRow(3)
    expect(r2.getCell(1).value ?? '').toBe('')
    expect(r2.getCell(2).value).toBe('+919787041101')
    expect(r2.getCell(4).value).toBe(919787041101)
    expect(r2.getCell(5).value ?? null).toBeNull()
    expect(r2.getCell(7).value ?? '').toBe('')
  })

  it('joins several tags and falls back to the WACRM purple for bad colours', async () => {
    const ws = await read(
      await buildContactsWorkbook([
        { name: 'A', phone: '919000000001', followupDate: null, tags: [{ name: 'Car', color: 'nonsense' }, { name: 'DNP' }], createdAt: '2026-10-11T05:00:00Z' },
      ]),
    )
    expect(ws.getRow(2).getCell(7).value).toBe('Car, DNP')
    expect(ws.getRow(2).getCell(7).fill).toMatchObject({ fgColor: { argb: 'FF8B5CF6' } })
  })
})
