import { describe, it, expect } from 'vitest'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v
    },
    has: (k: string) => k in data
  }
}

describe('StateManager', () => {
  it('seeds default state on first run with 5 companions', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const state = sm.getState()

    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
    expect(state.companions.map((c) => c.family).sort()).toEqual([
      'claude',
      'codex',
      'gemini',
      'hermes',
      'kimi'
    ])
  })

  it('seeds all 6 facility types on first run', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const state = sm.getState()
    expect(state.facilities).toHaveLength(6)
    expect(state.facilities.map((f) => f.facilityType).sort()).toEqual([
      'command-center',
      'data-archive',
      'foundry',
      'research-lab',
      'salvage-dock',
      'security-bay'
    ])
  })

  it('re-seeds state when cached version is stale (schema migration)', () => {
    const store = makeInMemoryStore()
    // Pre-populate store with v1 data (no facilities) to simulate pre-migration
    store.set('state', {
      version: 1,
      companions: [],
      facilities: [],
      deployments: [],
      logChunks: [],
      settings: {}
    })
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const state = sm.getState()
    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
    expect(state.facilities).toHaveLength(6)
  })

  it('seeds canonical mech-class mapping per spec §6', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const byFamily = Object.fromEntries(sm.getState().companions.map((c) => [c.family, c]))
    expect(byFamily.claude.mechClass).toBe('atlas')
    expect(byFamily.claude.name).toBe('Atlas-Prime')
    expect(byFamily.codex.mechClass).toBe('marauder')
    expect(byFamily.kimi.mechClass).toBe('raven')
    expect(byFamily.gemini.mechClass).toBe('catapult')
    expect(byFamily.hermes.mechClass).toBe('locust')
  })

  it('seeds soul/memory paths under userDataDir/mechbay/companions/<id>/', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const claude = sm.getState().companions.find((c) => c.family === 'claude')!
    expect(claude.soulPath).toMatch(/mechbay[\\/]companions[\\/].+[\\/]soul\.md$/)
    expect(claude.memoryPath).toMatch(/mechbay[\\/]companions[\\/].+[\\/]memory\.md$/)
  })

  it('seeds default settings (concurrency cap 3, ignored markers, projectsDir)', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const s = sm.getState()
    expect(s.settings.concurrencyCap).toBe(3)
    expect(s.settings.ignoredMarkers).toContain('node_modules')
    expect(s.settings.ignoredMarkers).toContain('Archived Projects DO NOT SCAN')
    expect(typeof s.settings.projectsDir).toBe('string')
  })

  it('persists updates via updateState()', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    sm.updateState((s) => ({ ...s, lastScanAt: 1234 }))
    expect(sm.getState().lastScanAt).toBe(1234)

    // Verify persistence reaches the store
    const sm2 = new StateManager(store, '/tmp/mechbay-test')
    expect(sm2.getState().lastScanAt).toBe(1234)
  })

  it('emits stateChanged events on update', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    let calls = 0
    sm.on('stateChanged', () => {
      calls++
    })
    sm.updateState((s) => ({ ...s, lastScanAt: 5678 }))
    sm.updateState((s) => ({ ...s, lastScanAt: 9999 }))
    expect(calls).toBe(2)
  })

  it('sweepZombieDeployments marks in-flight deployments failed and returns them', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/zombie-test')
    sm.updateState((s) => ({
      ...s,
      deployments: [
        {
          id: 'z1',
          companionId: 'c1',
          facilityId: 'f1',
          taskPrompt: 'do a thing',
          status: 'working',
          startedAt: 1
        },
        {
          id: 'z2',
          companionId: 'c2',
          facilityId: 'f2',
          taskPrompt: 'walk back',
          status: 'returning',
          startedAt: 2
        },
        {
          id: 'done1',
          companionId: 'c3',
          facilityId: 'f3',
          taskPrompt: 'already done',
          status: 'completed',
          startedAt: 3
        }
      ]
    }))

    const zombies = sm.sweepZombieDeployments()
    expect(zombies).toHaveLength(2)
    expect(zombies.every((z) => z.status === 'failed')).toBe(true)
    expect(zombies.every((z) => z.summary === 'Interrupted by app crash')).toBe(true)

    const stored = sm.getState().deployments
    expect(stored.find((d) => d.id === 'z1')!.status).toBe('failed')
    expect(stored.find((d) => d.id === 'z2')!.status).toBe('failed')
    expect(stored.find((d) => d.id === 'done1')!.status).toBe('completed')
  })

  it('sweepZombieDeployments is a no-op when no active deployments exist', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/zombie-noop-test')
    // Default seed has no deployments
    expect(sm.sweepZombieDeployments()).toEqual([])
  })

  it('preserves existing state on second instantiation (no re-seed)', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    const originalIds = sm.getState().companions.map((c) => c.id)
    const sm2 = new StateManager(store, '/tmp/mechbay-test')
    const reloadedIds = sm2.getState().companions.map((c) => c.id)
    expect(reloadedIds).toEqual(originalIds)
  })
})
