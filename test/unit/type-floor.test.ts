import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { fontSize } from '../../src/renderer/src/theme'

// Readability floor (v1.4.2): no app text below 11px. Sizes go through the
// type scale (--fs-* in command.css, fontSize in theme.ts); a literal size
// under the floor anywhere in the renderer fails here.
const RENDERER = path.resolve(__dirname, '../../src/renderer/src')
const FLOOR = 11

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return files(full)
    return /\.(css|tsx)$/.test(entry.name) ? [full] : []
  })
}

/** Every px size below the floor in a font, font-size or fontSize declaration. */
function tinySizes(source: string): string[] {
  const found: string[] = []
  const declarations = [
    ...source.matchAll(/font(?:-size)?\s*:\s*([^;{}]*)/g),
    ...source.matchAll(/fontSize:\s*([^,\n}]*)/g),
    ...source.matchAll(/font:\s*'([^']*)'/g)
  ]
  for (const [whole, value] of declarations) {
    // The size, not a line-height after the slash.
    const size = value.split('/')[0]
    for (const [, px] of size.matchAll(/(?<![\w.-])(\d+)(?:px)?(?![\w%.])/g)) {
      if (Number(px) > 0 && Number(px) < FLOOR) found.push(whole.trim())
    }
  }
  return found
}

describe('readability floor', () => {
  it('the type scale starts at the floor', () => {
    expect(Math.min(...Object.values(fontSize))).toBe(FLOOR)
    const css = readFileSync(path.join(RENDERER, 'assets/command.css'), 'utf8')
    expect(css).toContain(`--fs-label: ${FLOOR}px;`)
  })

  it('no renderer stylesheet or component sets text below 11px', () => {
    const offenders = files(RENDERER).flatMap((file) =>
      tinySizes(readFileSync(file, 'utf8')).map(
        (decl) => `${path.relative(RENDERER, file)}: ${decl}`
      )
    )
    expect(offenders).toEqual([])
  })

  it('catches a size under the floor', () => {
    expect(tinySizes('.x { font: 600 9px/1.2 var(--mono); }')).toHaveLength(1)
    expect(tinySizes("const s = { fontSize: 10, color: 'red' }")).toHaveLength(1)
    expect(tinySizes('.y { font-size: 12px; line-height: 9px; }')).toEqual([])
    expect(tinySizes('.z { font: 500 clamp(27px, 2.65vw, 44px)/1.04 serif; }')).toEqual([])
  })
})
