import { describe, expect, it } from 'vitest'
import { isOpenableExternalUrl } from '../../src/main/external-links'

describe('isOpenableExternalUrl', () => {
  it('opens https links in the browser', () => {
    expect(isOpenableExternalUrl('https://github.com/samalbanese/mechbay')).toBe(true)
  })

  it.each([
    'http://example.com/',
    'file:///C:/Windows/System32/calc.exe',
    'ms-settings:privacy',
    'smb://attacker/share',
    'javascript:alert(1)',
    'not a url',
    ''
  ])('refuses %s', (url) => {
    expect(isOpenableExternalUrl(url)).toBe(false)
  })
})
