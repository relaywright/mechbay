import { tmpdir } from 'os'
import { afterEach, describe, expect, it } from 'vitest'
import { killProcessTree } from '../../src/main/runners/process-tree'
import type { SpawnResult } from '../../src/main/runners/types'
import { FakeAgentRunner, isAlive, readPids, waitUntilDead } from '../helpers/fake-agent-runner'

// Cleanup only ever touches processes these tests started: the trees behind
// the spawn results they hold, and fixture PIDs not yet seen to exit (a PID
// seen dead is forgotten at once, so a reused PID is never signalled).
const started: SpawnResult[] = []
const fixturePids = new Set<number>()

afterEach(async () => {
  await Promise.all(started.splice(0).map((result) => result.abort()))
  for (const pid of fixturePids) {
    if (!isAlive(pid)) continue
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
  fixturePids.clear()
})

async function launch(): Promise<{ result: SpawnResult; pids: { parent: number; child: number } }> {
  const runner = new FakeAgentRunner({
    killTree: (child) => killProcessTree(child, { graceMs: 500 })
  })
  const result = await runner.spawn(tmpdir(), 'unused')
  started.push(result)
  const pids = await readPids(result.stream)
  fixturePids.add(pids.parent).add(pids.child)
  return { result, pids }
}

async function expectAllDead(pids: number[]): Promise<void> {
  const alive = await waitUntilDead(pids, 5000)
  for (const pid of pids) if (!alive.includes(pid)) fixturePids.delete(pid)
  expect(alive).toEqual([])
}

describe('recall guard (Phase 0 Track B done criterion)', () => {
  it('stopping a mission ends the agent and every process it started', async () => {
    const { result, pids } = await launch()
    expect(isAlive(pids.parent)).toBe(true)
    expect(isAlive(pids.child)).toBe(true)

    await result.abort()

    await expectAllDead([pids.parent, pids.child])
    await expect(result.exit).resolves.toBeTypeOf('number')
  }, 20_000)

  it('a second stop is harmless', async () => {
    const { result, pids } = await launch()
    await Promise.all([result.abort(), result.abort()])
    await result.abort()
    await expectAllDead([pids.parent, pids.child])
  }, 20_000)
})
