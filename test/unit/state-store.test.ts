import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { openStateStore } from '../../src/main/state-store'
import { JsonFileStore } from '../helpers/json-file-store'

describe('openStateStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mechbay-store-'))
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  // Mirrors electron-store: the constructor parses the file and throws a SyntaxError on bad JSON.
  const createStore = (name: string): JsonFileStore => {
    const file = path.join(dir, `${name}.json`)
    if (existsSync(file)) JSON.parse(readFileSync(file, 'utf8'))
    return new JsonFileStore(file)
  }

  it('opens a healthy store with no notice', () => {
    writeFileSync(path.join(dir, 'mechbay-state.json'), '{"state":{}}')
    const opened = openStateStore({ dir, name: 'mechbay-state', createStore })
    expect(opened.notice).toBeUndefined()
    expect(opened.store.has('state')).toBe(true)
  })

  it('moves a damaged file aside, keeps its bytes, and opens a fresh store', () => {
    writeFileSync(path.join(dir, 'mechbay-state.json'), '{"state": {"version": 2, "compan')
    const opened = openStateStore({
      dir,
      name: 'mechbay-state',
      createStore,
      now: () => new Date('2026-10-01T12:00:00.000Z')
    })
    const aside = path.join(dir, 'mechbay-state.corrupt-2026-10-01T12-00-00-000Z.json')
    expect(readFileSync(aside, 'utf8')).toBe('{"state": {"version": 2, "compan')
    expect(opened.store.has('state')).toBe(false)
    expect(opened.notice).toContain(aside)
    expect(opened.notice).not.toContain('—')
  })

  it('rethrows anything that is not a parse error and leaves the file alone', () => {
    writeFileSync(path.join(dir, 'mechbay-state.json'), '{}')
    const rename = vi.fn()
    expect(() =>
      openStateStore({
        dir,
        name: 'mechbay-state',
        rename,
        createStore: () => {
          throw Object.assign(new Error('EACCES: permission denied'), { code: 'EACCES' })
        }
      })
    ).toThrow('EACCES')
    expect(rename).not.toHaveBeenCalled()
    expect(readdirSync(dir)).toEqual(['mechbay-state.json'])
  })
})
