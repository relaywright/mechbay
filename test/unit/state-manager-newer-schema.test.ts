import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

const dirs: string[] = []

afterEach(() => {
  vi.restoreAllMocks()
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function userDataDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mechbay-newer-schema-'))
  dirs.push(dir)
  return dir
}

/** A store holding `saved` under the "state" key, with `set` spied on. */
function storeHolding(saved: unknown): StoreLike & { data: Record<string, unknown> } {
  const data: Record<string, unknown> = { state: saved }
  return {
    data,
    get: (k) => data[k],
    set: vi.fn((k: string, v: unknown) => {
      data[k] = v
    }),
    has: (k) => k in data
  }
}

/** What MechBay 1.4.2 (schema 3) might have written: this version can't read it. */
function schema3Bay(): Record<string, unknown> {
  return {
    version: 3,
    companions: [],
    facilities: [],
    deployments: [{ id: 'dep-1', companionId: 'atlas', facilityId: 'fac-lab', status: 'working' }],
    logChunks: [],
    settings: {},
    health: { lastGoodAt: 1_760_000_000_000 }
  }
}

describe('StateManager with a bay saved by a newer MechBay', () => {
  it('leaves the newer bay untouched and runs read-only on a default bay', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const original = schema3Bay()
    const store = storeHolding(structuredClone(original))

    const manager = new StateManager(store, userDataDir())

    expect(store.set).not.toHaveBeenCalled()
    expect(store.data.state).toEqual(original)
    expect(manager.isReadOnly()).toBe(true)
    expect(manager.getState().version).toBe(2)
    expect(manager.getState().companions).toHaveLength(5)
    expect(console.warn).toHaveBeenCalledWith(expect.stringContaining('schema 3'))
  })

  it('keeps working in memory but never saves while read-only', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = storeHolding(schema3Bay())
    const manager = new StateManager(store, userDataDir())
    const changed = vi.fn()
    manager.on('stateChanged', changed)

    manager.updateState((prev) => ({ ...prev, settings: { ...prev.settings, concurrencyCap: 5 } }))
    const swept = manager.sweepZombieDeployments()

    expect(manager.getState().settings.concurrencyCap).toBe(5)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(swept).toEqual([])
    expect(store.set).not.toHaveBeenCalled()
    expect((store.data.state as { version: number }).version).toBe(3)
  })

  it('still resets an older, unknown bay (version 1) to a fresh one', () => {
    const store = storeHolding({ version: 1, companions: [] })

    const manager = new StateManager(store, userDataDir())

    expect(manager.isReadOnly()).toBe(false)
    expect(store.set).toHaveBeenCalled()
    expect((store.data.state as { version: number }).version).toBe(2)
  })

  it('loads a valid schema 2 bay unchanged and stays writable', () => {
    const seeded = new StateManager(storeHolding(undefined), userDataDir()).getState()
    const store = storeHolding(structuredClone(seeded))

    const manager = new StateManager(store, userDataDir())

    expect(manager.isReadOnly()).toBe(false)
    expect(manager.getState()).toEqual(seeded)
    expect(store.set).not.toHaveBeenCalled()
  })
})
