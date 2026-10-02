import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'

const kimiMocks = vi.hoisted(() => ({
  readFile: vi.fn(),
  homedir: vi.fn()
}))

vi.mock('fs/promises', () => ({ readFile: kimiMocks.readFile }))
vi.mock('os', () => ({ homedir: kimiMocks.homedir }))

import { KimiRunner } from '../../src/main/runners/kimi'

/**
 * Kimi is invoked through our bundled Fireworks wrapper
 * (scripts/kimi_fireworks.py), not the native Moonshot `kimi` CLI.
 *
 * These tests lock in:
 *   1. availability requires both Python and the wrapper's Fireworks key
 *   2. argv is `[<scriptPath>, '-', '-v', '--narrate']` — the trailing
 *      '-' tells the wrapper to read the prompt from stdin; '--narrate'
 *      opts into the [INTENT]/[FINDINGS] chain-of-thought narration
 *   3. the prompt is actually piped to child.stdin and stdin is closed
 *   4. EPIPE on stdin doesn't throw — the child's exit event is the
 *      canonical error surface
 */

interface FakeStdin {
  write: ReturnType<typeof vi.fn>
  end: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
}

interface FakeChild extends EventEmitter {
  stdout: Readable
  stderr: Readable
  stdin: FakeStdin
  kill: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild
  child.stdout = Readable.from([])
  child.stderr = Readable.from([])
  child.stdin = {
    write: vi.fn(),
    end: vi.fn(),
    on: vi.fn()
  }
  child.kill = vi.fn()
  return child
}

const SCRIPT = '/fake/abs/path/kimi_fireworks.py'
const originalFireworksKey = process.env.FIREWORKS_API_KEY

beforeEach(() => {
  delete process.env.FIREWORKS_API_KEY
  kimiMocks.homedir.mockReset()
  kimiMocks.homedir.mockReturnValue('/fake/home')
  kimiMocks.readFile.mockReset()
  kimiMocks.readFile.mockRejectedValue(new Error('ENOENT'))
})

afterEach(() => {
  if (originalFireworksKey === undefined) {
    delete process.env.FIREWORKS_API_KEY
  } else {
    process.env.FIREWORKS_API_KEY = originalFireworksKey
  }
})

describe('KimiRunner (Fireworks wrapper)', () => {
  describe.each([
    { pythonPresent: true, envKeyPresent: true },
    { pythonPresent: true, envKeyPresent: false },
    { pythonPresent: false, envKeyPresent: true },
    { pythonPresent: false, envKeyPresent: false }
  ])(
    'availability with Python=$pythonPresent, env key=$envKeyPresent',
    ({ pythonPresent, envKeyPresent }) => {
      it('requires Python and a Fireworks key from the environment', async () => {
        if (envKeyPresent) process.env.FIREWORKS_API_KEY = 'env-fireworks-key'
        const which = vi.fn().mockResolvedValue(pythonPresent ? '/usr/local/bin/python' : null)
        const runner = new KimiRunner({ scriptPath: SCRIPT, which })

        expect(await runner.isAvailable()).toBe(pythonPresent && envKeyPresent)
        expect(which).toHaveBeenCalledWith('python')
      })
    }
  )

  it('never reads a key file from the home directory', async () => {
    kimiMocks.readFile.mockResolvedValue('FIREWORKS_API_KEY=file-fireworks-key\n')
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/usr/local/bin/python'
    })

    expect(await runner.isAvailable()).toBe(false)
    expect(kimiMocks.readFile).not.toHaveBeenCalled()
  })

  it('does not treat an empty environment value as a key', async () => {
    process.env.FIREWORKS_API_KEY = ''
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/usr/local/bin/python'
    })
    expect(await runner.isAvailable()).toBe(false)
  })

  it('accepts a stored Kimi secret when Python is available', async () => {
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/usr/local/bin/python',
      secrets: {
        getStatus: () => ({ claude: false, codex: false, kimi: true, gemini: false, hermes: false })
      }
    })
    expect(await runner.isAvailable()).toBe(true)
    expect(kimiMocks.readFile).not.toHaveBeenCalled()
  })

  it('invokes python with the script path, `-` (stdin sentinel), `-v`, and `--narrate`', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/fake/python',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp/workdir', 'Explore this project and summarize it.')
    expect(spawnCalls).toEqual([['python', [SCRIPT, '-', '-v', '--narrate']]])
  })

  it('pipes the full prompt to stdin and closes it', async () => {
    const child = makeFakeChild()
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/fake/python',
      spawnProcess: (() => child) as never
    })

    const bigPrompt =
      '# soul\nWide perspective first.\n\n# memory\n(empty)\n\n# task\nDo the thing.'
    await runner.spawn('/tmp', bigPrompt)

    expect(child.stdin.write).toHaveBeenCalledWith(bigPrompt)
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('registers an EPIPE-tolerant error handler on stdin', async () => {
    const child = makeFakeChild()
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/fake/python',
      spawnProcess: (() => child) as never
    })

    await runner.spawn('/tmp', 'hi')

    // The base class installs an `error` handler before writing.
    const errorHandlerCalls = child.stdin.on.mock.calls.filter((c) => c[0] === 'error')
    expect(errorHandlerCalls.length).toBeGreaterThanOrEqual(1)
  })

  it('does not hang when the child emits ENOENT (python not installed)', async () => {
    const child = makeFakeChild()
    const runner = new KimiRunner({
      scriptPath: SCRIPT,
      which: async () => '/fake/python',
      spawnProcess: (() => child) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => child.emit('error', new Error('spawn python ENOENT')), 5)

    const chunks: string[] = []
    for await (const c of result.stream) chunks.push(c.text)
    expect(chunks.join('')).toContain('ENOENT')
    expect(await result.exit).toBe(-1)
  })
})
