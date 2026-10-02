import { describe, it, expect, vi } from 'vitest'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

describe('StateManager — corrupt/malformed state handling', () => {
  it('falls back to defaults when stored state is corrupt JSON', () => {
    // Store returns a string that isn't valid JSON (simulating corruption)
    const corruptStore: StoreLike = {
      has: () => true,
      get: () => 'not valid json { broken',
      set: vi.fn()
    }

    const sm = new StateManager(corruptStore, '/tmp/mechbay-test')
    const state = sm.getState()

    // Should have seeded fresh defaults despite corrupt store
    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
    expect(state.facilities).toHaveLength(6)
    expect(state.deployments).toEqual([])
    expect(state.settings.concurrencyCap).toBe(3)
  })

  it('falls back to defaults when stored state is null', () => {
    const nullStore: StoreLike = {
      has: () => true,
      get: () => null,
      set: vi.fn()
    }

    const sm = new StateManager(nullStore, '/tmp/mechbay-test')
    const state = sm.getState()

    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
  })

  it('falls back to defaults when stored state is not an object', () => {
    const primitiveStore: StoreLike = {
      has: () => true,
      get: () => 42, // number instead of object
      set: vi.fn()
    }

    const sm = new StateManager(primitiveStore, '/tmp/mechbay-test')
    const state = sm.getState()

    expect(state.version).toBe(2)
    expect(Array.isArray(state.companions)).toBe(true)
  })

  it('re-seeds when stored state has missing required fields', () => {
    // State that passes basic validation but lacks required fields
    const incompleteStore: StoreLike = {
      has: () => true,
      get: () => ({ version: 2 }), // missing companions, facilities, etc.
      set: vi.fn()
    }

    const sm = new StateManager(incompleteStore, '/tmp/mechbay-test')
    const state = sm.getState()

    // Should detect incomplete state and re-seed
    expect(state.companions).toBeDefined()
    expect(state.facilities).toBeDefined()
    expect(state.settings).toBeDefined()
  })

  it('handles store.get throwing an exception', () => {
    const throwingStore: StoreLike = {
      has: () => true,
      get: () => {
        throw new Error('disk read error')
      },
      set: vi.fn()
    }

    const sm = new StateManager(throwingStore, '/tmp/mechbay-test')
    const state = sm.getState()

    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
  })

  it('handles store.has throwing an exception', () => {
    const throwingHasStore: StoreLike = {
      has: () => {
        throw new Error('has() failed')
      },
      get: vi.fn(),
      set: vi.fn()
    }

    const sm = new StateManager(throwingHasStore, '/tmp/mechbay-test')
    const state = sm.getState()

    expect(state.version).toBe(2)
    expect(state.companions).toHaveLength(5)
  })
})

describe('StateManager — store write failures', () => {
  it('updateState does not throw when store.set throws', () => {
    const data: Record<string, unknown> = {
      state: {
        version: 2,
        companions: [],
        facilities: [],
        deployments: [],
        logChunks: [],
        settings: {
          concurrencyCap: 3,
          ignoredMarkers: [],
          projectsDir: '/tmp',
          companionNameOverrides: {}
        }
      }
    }
    const throwingSetStore: StoreLike = {
      has: () => true,
      get: (k: string) => data[k],
      set: () => {
        throw new Error('disk full')
      }
    }

    const sm = new StateManager(throwingSetStore, '/tmp/mechbay-test')

    // updateState should NOT throw even if persistence fails (it catches and logs)
    expect(() => {
      sm.updateState((s) => ({ ...s, lastScanAt: 1234 }))
    }).not.toThrow()
  })

  it('emits stateChanged even when store.set throws', () => {
    const data: Record<string, unknown> = {
      state: {
        version: 2,
        companions: [],
        facilities: [],
        deployments: [],
        logChunks: [],
        settings: {
          concurrencyCap: 3,
          ignoredMarkers: [],
          projectsDir: '/tmp',
          companionNameOverrides: {}
        }
      }
    }
    let emitted = false

    const throwingSetStore: StoreLike = {
      has: () => true,
      get: (k: string) => data[k],
      set: () => {
        throw new Error('disk full')
      }
    }

    const sm = new StateManager(throwingSetStore, '/tmp/mechbay-test')
    sm.on('stateChanged', () => {
      emitted = true
    })

    // Should not throw - the error is caught internally
    sm.updateState((s) => ({ ...s, lastScanAt: 5678 }))

    // Event should have been emitted before the persistence attempt
    expect(emitted).toBe(true)
  })

  it('emits statePersistFailed when store.set throws', () => {
    const data: Record<string, unknown> = {
      state: {
        version: 2,
        companions: [],
        facilities: [],
        deployments: [],
        logChunks: [],
        settings: {
          concurrencyCap: 3,
          ignoredMarkers: [],
          projectsDir: '/tmp',
          companionNameOverrides: {}
        }
      }
    }
    let persistFailedEmitted = false
    let capturedErr: unknown

    const throwingSetStore: StoreLike = {
      has: () => true,
      get: (k: string) => data[k],
      set: () => {
        throw new Error('disk full')
      }
    }

    const sm = new StateManager(throwingSetStore, '/tmp/mechbay-test')
    sm.on('statePersistFailed', (_state, err) => {
      persistFailedEmitted = true
      capturedErr = err
    })

    sm.updateState((s) => ({ ...s, lastScanAt: 9999 }))

    expect(persistFailedEmitted).toBe(true)
    expect(capturedErr).toBeInstanceOf(Error)
    expect((capturedErr as Error).message).toBe('disk full')
  })
})

describe('StateManager — zombie sweep edge cases', () => {
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

  it('sweepZombieDeployments handles empty deployments array', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/zombie-test')

    // Default state has empty deployments
    expect(sm.sweepZombieDeployments()).toEqual([])
  })

  it('sweepZombieDeployments preserves non-active statuses', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/zombie-test')

    sm.updateState((s) => ({
      ...s,
      deployments: [
        {
          id: 'd1',
          companionId: 'c1',
          facilityId: 'f1',
          taskPrompt: 't1',
          status: 'completed',
          startedAt: 1,
          completedAt: 2,
          exitCode: 0
        },
        {
          id: 'd2',
          companionId: 'c2',
          facilityId: 'f2',
          taskPrompt: 't2',
          status: 'failed',
          startedAt: 3,
          completedAt: 4
        },
        {
          id: 'd3',
          companionId: 'c3',
          facilityId: 'f3',
          taskPrompt: 't3',
          status: 'cancelled',
          startedAt: 5,
          completedAt: 6
        },
        {
          id: 'd4',
          companionId: 'c4',
          facilityId: 'f4',
          taskPrompt: 't4',
          status: 'queued',
          startedAt: 7
        }
      ]
    }))

    const zombies = sm.sweepZombieDeployments()
    expect(zombies).toEqual([])

    // All non-active statuses should be unchanged
    const state = sm.getState()
    expect(
      state.deployments.every((d) =>
        ['completed', 'failed', 'cancelled', 'queued'].includes(d.status)
      )
    ).toBe(true)
  })

  it('sweepZombieDeployments marks all active statuses as failed', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/zombie-test')

    sm.updateState((s) => ({
      ...s,
      deployments: [
        {
          id: 'd1',
          companionId: 'c1',
          facilityId: 'f1',
          taskPrompt: 't1',
          status: 'walking-to',
          startedAt: 1
        },
        {
          id: 'd2',
          companionId: 'c2',
          facilityId: 'f2',
          taskPrompt: 't2',
          status: 'working',
          startedAt: 2
        },
        {
          id: 'd3',
          companionId: 'c3',
          facilityId: 'f3',
          taskPrompt: 't3',
          status: 'awaiting-input',
          startedAt: 3
        },
        {
          id: 'd4',
          companionId: 'c4',
          facilityId: 'f4',
          taskPrompt: 't4',
          status: 'returning',
          startedAt: 4
        }
      ]
    }))

    const zombies = sm.sweepZombieDeployments()
    expect(zombies).toHaveLength(4)
    expect(zombies.every((z) => z.status === 'failed')).toBe(true)
    expect(zombies.every((z) => z.summary === 'Interrupted by app crash')).toBe(true)
  })
})
