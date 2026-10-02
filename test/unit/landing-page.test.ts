import { readFileSync } from 'fs'
import { resolve } from 'path'
import { pathToFileURL } from 'url'
import { describe, expect, it } from 'vitest'

const SITE = readFileSync('site/index.html', 'utf8')
const ORIGIN = 'https://mechbay.samalbanese.com/'
const heroStart = SITE.indexOf('<section class="hero"')
const HERO = SITE.slice(heroStart, SITE.indexOf('</section>', heroStart))
const meta = (attr: 'property' | 'name', key: string): string | undefined =>
  SITE.match(new RegExp(`<meta ${attr}="${key}" content="([^"]+)"`))?.[1]

type Detect = (userAgent: string, platform?: string, maxTouchPoints?: number) => string | null
const { detectDesktopOs } = (await import(
  /* @vite-ignore */ pathToFileURL(resolve('site/download.js')).href
)) as { detectDesktopOs: Detect }

describe('landing page funnel', () => {
  it('link previews use absolute URLs on the canonical origin', () => {
    expect(meta('property', 'og:url')).toBe(ORIGIN)
    expect(meta('property', 'og:image')).toBe(`${ORIGIN}social-preview.png`)
    expect(meta('name', 'twitter:card')).toBe('summary_large_image')
    expect(meta('name', 'twitter:image')).toBe(`${ORIGIN}social-preview.png`)
    expect(SITE).toContain(`<link rel="canonical" href="${ORIGIN}">`)
  })

  it('leads with the plain-English promise', () => {
    expect(HERO).toContain(
      'Assign AI agents to real projects. Watch them work. Review exactly what they changed.'
    )
  })

  it('autoplays the hero video muted, looped and inline with a poster, and honors reduced motion', () => {
    const video = HERO.match(/<video[^>]*>/)?.[0] ?? ''
    for (const attr of [
      'autoplay',
      'muted',
      'loop',
      'playsinline',
      'poster="screenshot-bay.png"'
    ]) {
      expect(video).toContain(attr)
    }
    expect(SITE).toContain('prefers-reduced-motion: reduce')
  })

  it('offers a download that works without JavaScript and never sends the hero visitor to git clone', () => {
    expect(HERO).toContain('href="https://github.com/samalbanese/mechbay/releases/latest"')
    expect(HERO).not.toMatch(/quickstart|git clone/i)
    expect(SITE).toContain('<script type="module" src="download.js"></script>')
  })

  it('names and links the builder without a pronoun', () => {
    expect(SITE).toContain('href="https://samalbanese.com"')
    expect(SITE).not.toMatch(/\b(his|her) own\b/i)
  })

  it('does not pixelate non-pixel art', () => {
    expect(SITE).not.toContain('pixelated')
  })
})

describe('download button OS detection', () => {
  const WIN =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
  const MAC =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Safari/605.1.15'
  const IPHONE =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148'
  const ANDROID =
    'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Mobile Safari/537.36'
  const LINUX =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'
  const CROS =
    'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36'

  it('names the desktop OS', () => {
    expect(detectDesktopOs(WIN, 'Win32')).toBe('Windows')
    expect(detectDesktopOs(MAC, 'MacIntel', 0)).toBe('macOS')
    expect(detectDesktopOs(LINUX, 'Linux x86_64')).toBe('Linux')
  })

  it('never offers a desktop installer to a phone, a tablet, or a Chromebook', () => {
    expect(detectDesktopOs(IPHONE, 'iPhone')).toBeNull()
    expect(detectDesktopOs(MAC, 'MacIntel', 5)).toBeNull() // iPad in desktop mode
    expect(detectDesktopOs(ANDROID, 'Linux armv8l')).toBeNull()
    expect(detectDesktopOs(CROS, 'Linux x86_64')).toBeNull()
  })
})
