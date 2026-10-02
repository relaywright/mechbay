import { describe, expect, it } from 'vitest'
import { hasSameOrigin, isOpenableExternalUrl } from '../../src/main/external-links'

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

describe('hasSameOrigin', () => {
  const dev = 'http://localhost:5173'

  it('allows pages on the dev server', () => {
    expect(hasSameOrigin('http://localhost:5173/', dev)).toBe(true)
    expect(hasSameOrigin('http://localhost:5173/index.html?x=1', dev)).toBe(true)
  })

  it.each([
    'http://localhost:51730/', // a prefix match would let this through
    'http://localhost:5173.attacker.example/',
    'https://localhost:5173/',
    'http://127.0.0.1:5173/',
    'not a url'
  ])('refuses %s', (url) => {
    expect(hasSameOrigin(url, dev)).toBe(false)
  })

  it('refuses everything when there is no dev server (packaged app)', () => {
    expect(hasSameOrigin('http://localhost:5173/', undefined)).toBe(false)
  })
})
