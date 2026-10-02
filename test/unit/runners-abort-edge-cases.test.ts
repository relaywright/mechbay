import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { ClaudeRunner } from '../../src/main/runners/claude'

describe('ClaudeRunner — abort edge cases', () => {
  it('abort mid-stream stops yielding chunks', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
      killed: boolean
      exitCode: number | null
    }

    fakeChild.stdout = new Readable({
      read() {
        // No-op: the test feeds data with push()
      }
    })
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn(() => {
      fakeChild.killed = true
      // Emit close after kill
      setTimeout(() => fakeChild.emit('close'), 10)
      setTimeout(() => fakeChild.emit('exit', null, 'SIGTERM'), 15)
    })
    fakeChild.killed = false
    fakeChild.exitCode = null

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'long running task')

    // Start consuming the stream
    const collected: string[] = []
    const streamPromise = (async () => {
      for await (const chunk of result.stream) {
        collected.push(chunk.text)
        if (collected.length === 2) {
          // Abort after receiving 2 chunks
          result.abort()
        }
      }
    })()

    // Simulate chunks arriving
    setTimeout(() => {
      fakeChild.stdout.push('chunk 1\n')
      fakeChild.stdout.push('chunk 2\n')
    }, 5)

    // More chunks that should not be received due to abort
    setTimeout(() => {
      fakeChild.stdout.push('chunk 3 (should be ignored)\n')
    }, 50)

    await streamPromise

    // Should have received only the chunks before abort
    expect(collected.length).toBe(2)
    expect(collected).toContain('chunk 1\n')
    expect(collected).toContain('chunk 2\n')
    expect(fakeChild.kill).toHaveBeenCalledWith('SIGTERM')
  })

  it('abort after process already exited is a no-op', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
      killed: boolean
      exitCode: number | null
    }

    fakeChild.stdout = Readable.from(['output'])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()
    fakeChild.killed = false
    fakeChild.exitCode = null

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    // Emit exit before abort
    setTimeout(() => {
      fakeChild.exitCode = 0
      fakeChild.emit('exit', 0)
      fakeChild.emit('close')
    }, 5)

    // Consume stream
    for await (const _ of result.stream) {
      // drain
    }

    // Now abort - should be no-op since process already exited
    result.abort()

    expect(fakeChild.kill).not.toHaveBeenCalled()
  })

  it('abort when already killed is a no-op', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
      killed: boolean
      exitCode: number | null
    }

    fakeChild.stdout = Readable.from([])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn(() => {
      fakeChild.killed = true
    })
    fakeChild.killed = false
    fakeChild.exitCode = null

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    // First abort
    result.abort()
    expect(fakeChild.kill).toHaveBeenCalledTimes(1)

    // Second abort should be no-op
    result.abort()
    expect(fakeChild.kill).toHaveBeenCalledTimes(1)
  })

  it('handles kill throwing an exception', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
      killed: boolean
      exitCode: number | null
    }

    fakeChild.stdout = Readable.from([])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn(() => {
      throw new Error('kill failed')
    })
    fakeChild.killed = false
    fakeChild.exitCode = null

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    // Should not throw even if kill throws
    expect(() => result.abort()).not.toThrow()
  })
})

describe('ClaudeRunner — non-zero exit codes', () => {
  it('resolves exit with code 1 on failure', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }

    fakeChild.stdout = Readable.from(['some output'])
    fakeChild.stderr = Readable.from(['error message'])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'failing task')

    setTimeout(() => fakeChild.emit('exit', 1), 10)
    setTimeout(() => fakeChild.emit('close'), 15)

    // Drain stream
    for await (const _ of result.stream) {
      // drain
    }

    expect(await result.exit).toBe(1)
  })

  it('resolves exit with code 255 on fatal error', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }

    fakeChild.stdout = Readable.from([])
    fakeChild.stderr = Readable.from(['fatal error'])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    setTimeout(() => fakeChild.emit('exit', 255), 10)
    setTimeout(() => fakeChild.emit('close'), 15)

    for await (const _ of result.stream) {
      // drain
    }

    expect(await result.exit).toBe(255)
  })

  it('handles exit code null (killed by signal)', async () => {
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

    const result = await runner.spawn('/tmp', 'task')

    // null exit code means killed by signal
    setTimeout(() => fakeChild.emit('exit', null, 'SIGKILL'), 10)
    setTimeout(() => fakeChild.emit('close'), 15)

    for await (const _ of result.stream) {
      // drain
    }

    // Should resolve to -1 when exit code is null
    expect(await result.exit).toBe(-1)
  })
})

describe('ClaudeRunner — stream error handling', () => {
  it('handles stdout error during stream', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }

    const errorStream = new Readable({
      read() {
        // Will emit error
      }
    })

    fakeChild.stdout = errorStream
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    setTimeout(() => {
      errorStream.emit('error', new Error('stdout error'))
    }, 5)

    setTimeout(() => fakeChild.emit('exit', 0), 20)
    setTimeout(() => fakeChild.emit('close'), 25)

    const chunks: string[] = []
    for await (const chunk of result.stream) {
      chunks.push(chunk.text)
    }

    // Should have received the error message as stderr
    expect(chunks.some((c) => c.includes('stdout error'))).toBe(true)
  })

  it('handles stderr data correctly tagged', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }

    fakeChild.stdout = Readable.from(['stdout line\n'])
    fakeChild.stderr = Readable.from(['stderr warning\n'])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/usr/local/bin/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'task')

    setTimeout(() => fakeChild.emit('exit', 0), 10)
    setTimeout(() => fakeChild.emit('close'), 15)

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []

    for await (const chunk of result.stream) {
      if (chunk.stream === 'stdout') stdoutChunks.push(chunk.text)
      else stderrChunks.push(chunk.text)
    }

    expect(stdoutChunks.join('')).toContain('stdout line')
    expect(stderrChunks.join('')).toContain('stderr warning')
  })
})
