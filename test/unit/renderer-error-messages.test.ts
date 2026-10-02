import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../../src/shared/bridge-errors'

// A failed bridge call reaches the renderer as "Error invoking remote method
// 'x': Error: ...". The renderer shows ipcErrorMessage(err), never err.message.
const RENDERER = path.resolve(__dirname, '../../src/renderer/src')
// Names given to a caught error: `catch (err)` and `.catch((err) => ...)`.
const CAUGHT = /\bcatch\s*\(\s*\(?\s*(\w+)/g

function sources(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return sources(full)
    return /\.tsx?$/.test(entry.name) ? [full] : []
  })
}

/** Places where a caught error's own text is used instead of ipcErrorMessage(err). */
function rawErrorUses(source: string): string[] {
  const names = new Set([...source.matchAll(CAUGHT)].map((m) => m[1]))
  return [...names].flatMap((name) => {
    const raw = new RegExp(`\\b${name}\\s*\\.\\s*message\\b|String\\(\\s*${name}\\s*\\)`, 'g')
    return [...source.matchAll(raw)].map((m) => m[0].replace(/\s+/g, ''))
  })
}

describe('renderer error messages', () => {
  it('no renderer file shows a raw error message', () => {
    const offenders = sources(RENDERER).flatMap((file) =>
      rawErrorUses(readFileSync(file, 'utf8')).map(
        (use) => `${path.relative(RENDERER, file)}: ${use}`
      )
    )
    expect(offenders).toEqual([])
  })

  it('the guard catches the usual ways of showing a raw error', () => {
    expect(rawErrorUses('try { load() } catch (err) { setError(err.message) }')).toEqual([
      'err.message'
    ])
    const multiline = [
      'load().catch((failure) =>',
      '  setError(',
      '    failure instanceof Error',
      '      ? failure',
      '          .message',
      '      : String(failure)',
      '  )',
      ')'
    ].join('\n')
    expect(rawErrorUses(multiline)).toEqual(['failure.message', 'String(failure)'])
    expect(rawErrorUses('catch (err) { setError(ipcErrorMessage(err)) }')).toEqual([])
  })

  it('ipcErrorMessage strips the Electron wrapper', () => {
    const wrapped = new Error(
      "Error invoking remote method 'fs:read-dir': Error: That folder is outside the project."
    )
    expect(ipcErrorMessage(wrapped)).toBe('That folder is outside the project.')
    expect(ipcErrorMessage('plain text')).toBe('plain text')
  })
})
