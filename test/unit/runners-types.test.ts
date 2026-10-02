import { describe, it, expect } from 'vitest'
import type { Runner, RunnerChunk } from '../../src/main/runners/types'

describe('Runner interface', () => {
  it('has the required shape (compiles to valid Runner instance)', () => {
    // Type-level test — if this compiles, it passes.
    const fakeRunner: Runner = {
      spawn: async () => ({
        stream: (async function* () {
          yield { stream: 'stdout', text: '' } as RunnerChunk
        })(),
        abort: async () => {},
        exit: Promise.resolve(0)
      }),
      isAvailable: async () => true
    }
    expect(fakeRunner).toBeDefined()
    expect(typeof fakeRunner.spawn).toBe('function')
    expect(typeof fakeRunner.isAvailable).toBe('function')
  })
})
