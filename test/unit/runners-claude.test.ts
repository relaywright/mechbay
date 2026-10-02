import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { ClaudeRunner } from '../../src/main/runners/claude'

describe('ClaudeRunner.isAvailable', () => {
  it('returns true when claude CLI is on PATH', async () => {
    const runner = new ClaudeRunner({
      which: async (_cmd: string) => '/usr/local/bin/claude'
    })
    expect(await runner.isAvailable()).toBe(true)
  })

  it('returns false when claude CLI is missing', async () => {
    const runner = new ClaudeRunner({
      which: async (_cmd: string) => null
    })
    expect(await runner.isAvailable()).toBe(false)
  })
})

describe('ClaudeRunner.spawn', () => {
  it('yields stdout chunks as RunnerChunk stream', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from(['hello ', 'world'])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'echo test')
    setTimeout(() => fakeChild.emit('close', 0), 10)
    setTimeout(() => fakeChild.emit('exit', 0), 11)

    const chunks: string[] = []
    for await (const chunk of result.stream) {
      chunks.push(chunk.text)
    }

    expect(chunks.join('')).toBe('hello world')
    expect(await result.exit).toBe(0)
  })

  it('separates stdout and stderr chunks by stream tag', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from(['out'])
    fakeChild.stderr = Readable.from(['err'])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => fakeChild.emit('close', 0), 10)
    setTimeout(() => fakeChild.emit('exit', 0), 11)

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    for await (const chunk of result.stream) {
      if (chunk.stream === 'stdout') stdoutChunks.push(chunk.text)
      else stderrChunks.push(chunk.text)
    }

    expect(stdoutChunks.join('')).toBe('out')
    expect(stderrChunks.join('')).toBe('err')
  })

  it('abort() stops the process tree once', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from([])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()
    const killTree = vi.fn(async () => {})

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never,
      killTree
    })

    const result = await runner.spawn('/tmp', 'noop')
    await result.abort()
    await result.abort()
    expect(killTree).toHaveBeenCalledTimes(1)
    expect(killTree).toHaveBeenCalledWith(fakeChild)

    setTimeout(() => fakeChild.emit('close', 0), 5)
    setTimeout(() => fakeChild.emit('exit', 143), 6)
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(await result.exit).toBe(143)
  })

  it('does not hang when spawn emits error (e.g. ENOENT, no close/exit)', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from([])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    // Simulate Node's spawn-error emission. Critically, no 'close' or
    // 'exit' event will follow — ENOENT/EPERM are terminal by themselves.
    setTimeout(() => fakeChild.emit('error', new Error('spawn claude ENOENT')), 5)

    const chunks: string[] = []
    for await (const c of result.stream) chunks.push(c.text)

    expect(chunks.join('')).toContain('ENOENT')
    expect(await result.exit).toBe(-1)
  })
})
