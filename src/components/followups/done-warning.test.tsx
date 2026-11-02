import { describe, expect, it } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { NextIntlClientProvider } from 'next-intl'
import en from '../../../messages/en.json'
import { FollowupDoneWarning } from './done-warning'

const render = (props: Partial<React.ComponentProps<typeof FollowupDoneWarning>> = {}) =>
  renderToStaticMarkup(
    <NextIntlClientProvider locale="en" messages={en}>
      <FollowupDoneWarning onConfirm={() => {}} onCancel={() => {}} {...props} />
    </NextIntlClientProvider>,
  )

describe('FollowupDoneWarning', () => {
  it('warns before closing a follow-up and offers Cancel / Yes', () => {
    const html = render({ name: 'Ravi Kumar' })
    expect(html).toContain('role="alertdialog"')
    expect(html).toContain('Mark this follow-up as done?')
    expect(html).toContain('Ravi Kumar')
    expect(html).toContain('Cancel')
    expect(html).toContain('Yes, mark done')
  })
  it('works without a name', () => {
    expect(render()).toContain('reminders will stop')
  })
  it('disables both buttons while saving', () => {
    const html = render({ busy: true })
    expect((html.match(/\sdisabled=""/g) ?? []).length).toBe(2)
  })
})
