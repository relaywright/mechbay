import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import { CURRENT_SCHEMA_VERSION } from '../../src/main/state-migrations'

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

const NEWER = CURRENT_SCHEMA_VERSION + 1

/** What a future MechBay (one schema ahead) might have written: this version can't read it. */
function newerBay(): Record<string, unknown> {
  return {
    version: NEWER,
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
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const original = newerBay()
    const store = storeHolding(structuredClone(original))

    const manager = new StateManager(store, userDataDir())

    expect(store.set).not.toHaveBeenCalled()
    expect(store.data.state).toEqual(original)
    expect(manager.getHealth()).toMatchObject({ ok: false, reason: 'newer-version' })
    expect(manager.getState().version).toBe(CURRENT_SCHEMA_VERSION)
    expect(manager.getState().companions).toHaveLength(5)
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining(`schema ${NEWER}`))
  })

  it('keeps working in memory but never saves while read-only', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const store = storeHolding(newerBay())
    const manager = new StateManager(store, userDataDir())
    const changed = vi.fn()
    manager.on('stateChanged', changed)

    manager.updateState((prev) => ({ ...prev, settings: { ...prev.settings, concurrencyCap: 5 } }))
    const swept = manager.sweepZombieDeployments()

    expect(manager.getState().settings.concurrencyCap).toBe(5)
    expect(changed).toHaveBeenCalledTimes(1)
    expect(swept).toEqual([])
    expect(store.set).not.toHaveBeenCalled()
    expect((store.data.state as { version: number }).version).toBe(NEWER)
  })

  it('never backs up a newer bay either', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const copyFile = vi.fn()
    const store = Object.assign(storeHolding(newerBay()), { path: '/tmp/mechbay-state.json' })

    const manager = new StateManager(store, userDataDir(), { copyFile })

    expect(copyFile).not.toHaveBeenCalled()
    expect(store.set).not.toHaveBeenCalled()
    expect(manager.getHealth()).toMatchObject({
      ok: false,
      reason: 'newer-version',
      statePath: '/tmp/mechbay-state.json'
    })
  })

  it('still resets an older, unknown bay (version 1) to a fresh one', () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const store = storeHolding({ version: 1, companions: [] })

    const manager = new StateManager(store, userDataDir())

    expect(manager.getHealth().ok).toBe(true)
    expect(store.set).toHaveBeenCalled()
    expect((store.data.state as { version: number }).version).toBe(CURRENT_SCHEMA_VERSION)
  })

  // A future schema is a whole number; 2.5 or Infinity is a corrupt value, not a newer MechBay.
  it.each([2.5, Number.POSITIVE_INFINITY, Number.NaN, Number.MAX_SAFE_INTEGER + 2])(
    'treats version %s as malformed, not newer',
    (version) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const store = storeHolding({ version, companions: [] })

      const manager = new StateManager(store, userDataDir())

      expect(manager.getHealth()).toMatchObject({
        ok: true,
        notice: expect.stringContaining('fresh')
      })
      expect((store.data.state as { version: number }).version).toBe(CURRENT_SCHEMA_VERSION)
    }
  )

  it('loads a valid current bay unchanged and stays writable', () => {
    const seeded = new StateManager(storeHolding(undefined), userDataDir()).getState()
    const store = storeHolding(structuredClone(seeded))

    const manager = new StateManager(store, userDataDir())

    expect(manager.getHealth()).toEqual({ ok: true })
    expect(manager.getState()).toEqual(seeded)
    expect(store.set).not.toHaveBeenCalled()
  })
})
