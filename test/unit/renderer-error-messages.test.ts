import { readdirSync, readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import { ipcErrorMessage } from '../../src/shared/bridge-errors'

// A failed bridge call reaches the renderer as "Error invoking remote method
// 'x': Error: ...". Components show ipcErrorMessage(err), never err.message.
const RENDERER = path.resolve(__dirname, '../../src/renderer/src')
const RAW = /instanceof Error \? \w+\.message : String\(/

function components(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return components(full)
    return entry.name.endsWith('.tsx') ? [full] : []
  })
}

describe('renderer error messages', () => {
  it('no component shows a raw error message', () => {
    const offenders = components(RENDERER).flatMap((file) =>
      readFileSync(file, 'utf8')
        .split('\n')
        .flatMap((line, i) =>
          RAW.test(line) ? [`${path.relative(RENDERER, file)}:${i + 1}`] : []
        )
    )
    expect(offenders).toEqual([])
  })

  it('ipcErrorMessage strips the Electron wrapper', () => {
    const wrapped = new Error(
      "Error invoking remote method 'fs:read-dir': Error: That folder is outside the project."
    )
    expect(ipcErrorMessage(wrapped)).toBe('That folder is outside the project.')
    expect(ipcErrorMessage('plain text')).toBe('plain text')
  })
})
