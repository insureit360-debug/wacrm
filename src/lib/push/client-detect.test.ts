import { describe, expect, it } from 'vitest'
import { detectBrowser, sameKey } from './client'

describe('detectBrowser', () => {
  it('recognises the main browsers (Brave needs its own API, not the UA)', () => {
    expect(detectBrowser('Mozilla/5.0 Chrome/120 Safari/537.36', true)).toBe('brave')
    expect(detectBrowser('Mozilla/5.0 Gecko/20100101 Firefox/130.0', false)).toBe('firefox')
    expect(detectBrowser('Mozilla/5.0 Chrome/120 Safari/537.36 Edg/120', false)).toBe('edge')
    expect(detectBrowser('Mozilla/5.0 (Linux; Android 14) Chrome/120 Mobile Safari/537.36', false)).toBe('chrome')
    expect(detectBrowser('Mozilla/5.0 (iPhone) AppleWebKit Version/17 Safari/604.1', false)).toBe('safari')
    expect(detectBrowser('curl/8', false)).toBe('other')
  })
})

describe('sameKey', () => {
  it('compares a stored applicationServerKey with the server key', () => {
    const a = new Uint8Array([1, 2, 3])
    expect(sameKey(a.buffer.slice(0) as ArrayBuffer, new Uint8Array([1, 2, 3]))).toBe(true)
    expect(sameKey(a.buffer.slice(0) as ArrayBuffer, new Uint8Array([1, 2, 4]))).toBe(false)
    expect(sameKey(null, a)).toBe(false)
  })
})
