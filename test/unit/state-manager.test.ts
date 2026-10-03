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

    expect(state.version).toBe(3)
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

  it('starts a fresh bay when the saved schema predates the first release', () => {
    const store = makeInMemoryStore()
    // Schema 1 never shipped, so there is nothing to migrate from
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
    expect(state.version).toBe(3)
    expect(state.companions).toHaveLength(5)
    expect(state.facilities).toHaveLength(6)
    expect(sm.getHealth()).toMatchObject({
      ok: true,
      notice: expect.stringContaining('fresh'),
      freshBay: true
    })
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
    sm.updateState((s) => ({ ...s, settings: { ...s.settings, concurrencyCap: 5 } }))
    expect(sm.getState().settings.concurrencyCap).toBe(5)

    // Verify persistence reaches the store
    const sm2 = new StateManager(store, '/tmp/mechbay-test')
    expect(sm2.getState().settings.concurrencyCap).toBe(5)
  })

  it('emits stateChanged events on update', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/mechbay-test')
    let calls = 0
    sm.on('stateChanged', () => {
      calls++
    })
    sm.updateState((s) => ({ ...s, settings: { ...s.settings, concurrencyCap: 4 } }))
    sm.updateState((s) => ({ ...s, settings: { ...s.settings, concurrencyCap: 5 } }))
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
    expect(
      zombies.every((z) => z.summary === 'Interrupted when MechBay closed unexpectedly.')
    ).toBe(true)

    const stored = sm.getState().deployments
    expect(stored.find((d) => d.id === 'z1')!.status).toBe('failed')
    expect(stored.find((d) => d.id === 'z2')!.status).toBe('failed')
    expect(stored.find((d) => d.id === 'done1')!.status).toBe('completed')
  })

  it('cancels missions that were still queued', () => {
    const sm = new StateManager(makeInMemoryStore(), '/tmp/zombie-queued-test')
    sm.updateState((s) => ({
      ...s,
      deployments: [
        {
          id: 'q1',
          companionId: 'c1',
          facilityId: 'f1',
          taskPrompt: 'still waiting',
          status: 'queued',
          startedAt: 1
        },
        {
          id: 'w1',
          companionId: 'c2',
          facilityId: 'f2',
          taskPrompt: 'was running',
          status: 'working',
          startedAt: 2
        }
      ]
    }))

    const changed = sm.sweepZombieDeployments()
    expect(changed.map((d) => [d.id, d.status])).toEqual([
      ['q1', 'cancelled'],
      ['w1', 'failed']
    ])
    const queued = sm.getState().deployments.find((d) => d.id === 'q1')!
    expect(queued.status).toBe('cancelled')
    expect(queued.summary).toBe('Cancelled: MechBay closed before it started.')
    expect(queued.completedAt).toEqual(expect.any(Number))
    // Idempotent: a second sweep finds nothing left open.
    expect(sm.sweepZombieDeployments()).toEqual([])
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
