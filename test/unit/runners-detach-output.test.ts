import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { ClaudeRunner } from '../../src/main/runners/claude'

type FakeChild = EventEmitter & {
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn>
  killed: boolean
  exitCode: number | null
}

function fakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  // The test feeds both streams with push(), so read() has nothing to do.
  const fedByTest = (): void => undefined
  child.stdout = new Readable({ read: fedByTest })
  child.stderr = new Readable({ read: fedByTest })
  child.kill = vi.fn()
  child.killed = false
  child.exitCode = null
  return child
}

// The agent exited, but a process it started still holds the output open:
// the pipe never closes. Once MechBay stops reading, the runner must stop
// collecting that process's output too, or it piles up in memory.
describe('detachOutput', () => {
  it('ends the stream and stops collecting output from a pipe that never closes', async () => {
    const child = fakeChild()
    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => child) as never,
      killTree: vi.fn(async () => {})
    })
    const result = await runner.spawn('/tmp', 'task')
    const collected: string[] = []
    const reading = (async () => {
      for await (const chunk of result.stream) collected.push(chunk.text)
    })()

    child.stdout.push('{"type":"system","subtype":"init"}\n')
    child.emit('exit', 0)
    await new Promise((r) => setTimeout(r, 10))

    expect(result.detachOutput).toBeTypeOf('function')
    result.detachOutput!()
    await reading

    expect(child.stdout.listenerCount('data')).toBe(0)
    expect(child.stderr.listenerCount('data')).toBe(0)
    // Still flowing, so the leftover process never blocks on a full pipe.
    expect(child.stdout.readableFlowing).toBe(true)
    child.stdout.push('dev server log line\n')
    child.stderr.push('dev server warning\n')
    await new Promise((r) => setTimeout(r, 10))
    expect(collected.join('')).not.toContain('dev server')
  })
})
