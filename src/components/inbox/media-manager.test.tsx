import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import en from '../../../messages/en.json'
import { MediaManagerButton, formatBytes } from './media-manager'

describe('formatBytes', () => {
  it('formats sizes', () => {
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(2048)).toBe('2 KB')
    expect(formatBytes(5 * 1024 * 1024)).toBe('5.0 MB')
    expect(formatBytes(3 * 1024 ** 3)).toBe('3.00 GB')
  })
})

describe('MediaManagerButton', () => {
  it('renders only a small Files button until opened (nothing is fetched or deleted on render)', () => {
    const html = renderToStaticMarkup(
      <NextIntlClientProvider locale="en" messages={en}>
        <MediaManagerButton conversationId="c-1" onDeleted={() => {}} />
      </NextIntlClientProvider>,
    )
    expect(html).toContain('Files')
    expect(html).not.toContain('Delete selected')
    expect(html).not.toContain('Free up storage')
  })
})
