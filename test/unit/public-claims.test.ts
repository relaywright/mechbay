import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import { RUNTIME_SUPPORT } from '../../src/shared/runtime-support'

const read = (file: string): string => readFileSync(file, 'utf8')
const PUBLIC_COPY = ['README.md', 'CONTRIBUTING.md', 'site/index.html'] as const
const UNVERIFIED = Object.values(RUNTIME_SUPPORT).filter((support) => !support.verifiedByAuthor)

describe('public claims (S3: zero claim drift)', () => {
  it.each(PUBLIC_COPY)('%s does not hand-type a test count', (file) => {
    expect(read(file)).not.toMatch(
      /\b\d[\d,]*\+?\s+(?:(?:unit|integration|automated|and)\s+)*tests?\b/i
    )
  })

  // Public copy describes the queue in plain words, never as "FIFO".
  it.each(PUBLIC_COPY)('%s makes no FIFO claim', (file) => {
    expect(read(file)).not.toMatch(/\bFIFO\b/)
  })

  it('backs the queue-order claim with the FIFO regression test', () => {
    for (const file of ['README.md', 'site/index.html']) {
      expect(read(file)).toContain('start in the order you sent them')
    }
    expect(read('test/unit/ipc-queue.test.ts')).toContain('starts queued missions oldest first')
  })

  it.each(PUBLIC_COPY)('%s has no stale "verified as of" claim', (file) => {
    expect(read(file)).not.toMatch(/verified as of/i)
  })

  // P1-08 (web demo) and P2-08 (real missions) ship approve controls; they update this test.
  it.each(PUBLIC_COPY)('%s makes no approve claim before an approve control exists', (file) => {
    expect(read(file)).not.toMatch(/\bapprov/i)
  })

  it.each(PUBLIC_COPY)('%s contains no em dashes', (file) => {
    expect(read(file)).not.toContain('\u2014')
  })

  it('README names the demo facility the way the app does', () => {
    expect(read('README.md')).toContain('`reactor-control`')
  })

  it("landing page's memory example uses the format appendMemoryEntry writes", () => {
    const html = read('site/index.html')
    const example = html.slice(html.indexOf('Example memory file'), html.indexOf('</pre>'))
    // appendMemoryEntry: `## YYYY-MM-DD HH:MM · <facility name> · "<task>"`, then the outcome line.
    expect(example).toMatch(/## \d{4}-\d{2}-\d{2} \d{2}:\d{2} · reactor-control · "[^"]+"/)
    expect(example).toMatch(/Completed\. \d+ files? changed, \+\d+ −\d+\./)
    // Lines MechBay never writes.
    expect(example).not.toMatch(/Next time|Edits:|Objective:/)
  })

  it('README labels every runtime the author has not verified', () => {
    const rows = read('README.md')
      .split('\n')
      .filter((line) => line.startsWith('|'))
    for (const support of UNVERIFIED) {
      const row = rows.find((line) => line.includes(support.label))
      expect(row, support.label).toBeDefined()
      expect(row).toMatch(/not verified by the author/i)
    }
  })

  it('the landing page roster labels every runtime the author has not verified', () => {
    const cards = read('site/index.html').split('<article')
    for (const support of UNVERIFIED) {
      const card = cards.find((chunk) => chunk.includes(`RUNTIME // ${support.siteLabel}<`))
      expect(card, support.siteLabel).toBeDefined()
      expect(card).toMatch(/Not verified by the author/)
    }
  })
})
