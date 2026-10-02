import { describe, it, expect, vi } from 'vitest'
import { runCliAvailabilityCheck } from '../../src/main/cli-check'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner, SpawnResult } from '../../src/main/runners/types'
import type { AgentFamily } from '../../src/shared/types'

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

describe('runCliAvailabilityCheck — timeout and hang scenarios', () => {
  it('handles runner that never resolves (hangs)', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const hangingRunner: Runner = {
      isAvailable: () => new Promise(() => {}) // never resolves
    }

    const runners: Record<AgentFamily, Runner> = {
      claude: hangingRunner,
      codex: { isAvailable: async () => true } as Runner,
      kimi: { isAvailable: async () => false } as Runner,
      gemini: { isAvailable: async () => true } as Runner,
      hermes: { isAvailable: async () => false } as Runner
    }

    // The current implementation uses Promise.all, so if one hangs, all hang
    // This test documents that behavior - a real fix would need timeouts
    const timeoutPromise = new Promise<void>((_, reject) => {
      setTimeout(() => reject(new Error('Timeout')), 100)
    })

    const checkPromise = runCliAvailabilityCheck(state, runners)

    // Expect the check to hang (no resolution within timeout)
    await expect(Promise.race([checkPromise, timeoutPromise])).rejects.toThrow('Timeout')
  })

  it('handles runner that resolves very slowly (slow probe)', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const slowRunner: Runner = {
      isAvailable: async () => {
        await new Promise((r) => setTimeout(r, 50)) // 50ms delay
        return true
      }
    }

    const runners: Record<AgentFamily, Runner> = {
      claude: slowRunner,
      codex: slowRunner,
      kimi: slowRunner,
      gemini: slowRunner,
      hermes: slowRunner
    }

    // All slow but all resolve - should complete
    const start = Date.now()
    await runCliAvailabilityCheck(state, runners)
    const elapsed = Date.now() - start

    // Should complete in roughly 50ms (parallel), not 250ms (sequential)
    expect(elapsed).toBeLessThan(200)

    // All should be marked available
    expect(state.getState().companions.every((c) => c.cliAvailable === true)).toBe(true)
  })

  it('handles mixed fast/slow runners (parallel execution)', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const fastRunner = (available: boolean): Runner => ({
      isAvailable: async () => available
    })

    const slowRunner = (available: boolean): Runner => ({
      isAvailable: async () => {
        await new Promise((r) => setTimeout(r, 50))
        return available
      }
    })

    const runners: Record<AgentFamily, Runner> = {
      claude: fastRunner(true),
      codex: slowRunner(true),
      kimi: fastRunner(false),
      gemini: slowRunner(false),
      hermes: fastRunner(true)
    }

    const start = Date.now()
    await runCliAvailabilityCheck(state, runners)
    const elapsed = Date.now() - start

    // Should wait for slow runners (50ms+), not just fast ones
    expect(elapsed).toBeGreaterThanOrEqual(40)

    const byFamily = Object.fromEntries(
      state.getState().companions.map((c) => [c.family, c.cliAvailable])
    )
    expect(byFamily.claude).toBe(true)
    expect(byFamily.codex).toBe(true)
    expect(byFamily.kimi).toBe(false)
    expect(byFamily.gemini).toBe(false)
    expect(byFamily.hermes).toBe(true)
  })

  it('handles runner that throws after delay', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const delayedThrowRunner: Runner = {
      isAvailable: async () => {
        await new Promise((r) => setTimeout(r, 20))
        throw new Error('delayed error')
      }
    }

    const runners: Record<AgentFamily, Runner> = {
      claude: delayedThrowRunner,
      codex: { isAvailable: async () => true } as Runner,
      kimi: { isAvailable: async () => true } as Runner,
      gemini: { isAvailable: async () => true } as Runner,
      hermes: { isAvailable: async () => true } as Runner
    }

    // Should complete despite delayed throw
    await runCliAvailabilityCheck(state, runners)

    const claude = state.getState().companions.find((c) => c.family === 'claude')!
    expect(claude.cliAvailable).toBe(false)

    // Others should still be updated
    expect(state.getState().companions.filter((c) => c.cliAvailable).length).toBe(4)
  })
})

describe('runCliAvailabilityCheck — partial failure scenarios', () => {
  it('updates state even when some runners fail', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const runners: Record<AgentFamily, Runner> = {
      claude: { isAvailable: async () => true } as Runner,
      codex: {
        isAvailable: async () => {
          throw new Error('codex error')
        }
      } as Runner,
      kimi: { isAvailable: async () => false } as Runner,
      gemini: { isAvailable: async () => true } as Runner,
      hermes: {
        isAvailable: async () => {
          throw new Error('hermes error')
        }
      } as Runner
    }

    await runCliAvailabilityCheck(state, runners)

    const byFamily = Object.fromEntries(
      state.getState().companions.map((c) => [c.family, c.cliAvailable])
    )

    // Available ones should be true
    expect(byFamily.claude).toBe(true)
    expect(byFamily.gemini).toBe(true)

    // Unavailable (returned false) should be false
    expect(byFamily.kimi).toBe(false)

    // Thrown errors should be treated as unavailable
    expect(byFamily.codex).toBe(false)
    expect(byFamily.hermes).toBe(false)
  })

  it('handles all runners throwing', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const runners: Record<AgentFamily, Runner> = {
      claude: {
        isAvailable: async () => {
          throw new Error('error1')
        }
      } as Runner,
      codex: {
        isAvailable: async () => {
          throw new Error('error2')
        }
      } as Runner,
      kimi: {
        isAvailable: async () => {
          throw new Error('error3')
        }
      } as Runner,
      gemini: {
        isAvailable: async () => {
          throw new Error('error4')
        }
      } as Runner,
      hermes: {
        isAvailable: async () => {
          throw new Error('error5')
        }
      } as Runner
    }

    // Should not throw - should complete and mark all as unavailable
    await expect(runCliAvailabilityCheck(state, runners)).resolves.toBeUndefined()

    expect(state.getState().companions.every((c) => c.cliAvailable === false)).toBe(true)
  })

  it('handles empty runners map', async () => {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/cli-check-test')

    const runners = {} as Record<AgentFamily, Runner>

    // Should complete without error
    await expect(runCliAvailabilityCheck(state, runners)).resolves.toBeUndefined()

    // All companions should be marked unavailable (no runner = not available)
    expect(state.getState().companions.every((c) => c.cliAvailable === false)).toBe(true)
  })
})
