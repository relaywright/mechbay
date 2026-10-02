import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import type { Runner } from '../../src/main/runners/types'
import { ClaudeRunner } from '../../src/main/runners/claude'
import { CodexRunner } from '../../src/main/runners/codex'
import { GeminiRunner } from '../../src/main/runners/gemini'
import { HermesRunner } from '../../src/main/runners/hermes'

/**
 * Every CLI-backed runner shares one spawn implementation (CliRunner
 * base class). The matrix test here locks in:
 *   1. which command each runner probes for availability
 *   2. what argv each runner passes to spawn() for a given prompt
 *   3. that the shared spawn plumbing (ENOENT → no hang, SIGTERM abort,
 *      stream drain) still works for every subclass
 *
 * If you add a new CLI-backed runner, add one row to CASES and the
 * same three properties are verified for free.
 *
 * Kimi is NOT in this matrix — it shells out to our bundled
 * kimi_fireworks.py Python wrapper and uses the stdin hook to pipe
 * the prompt (instead of argv), so the generic matrix doesn't model
 * its interface. Its interface is covered by runners-kimi.test.ts.
 */

interface Case {
  label: string
  Runner: new (deps: unknown) => Runner
  expectedCommand: string
  expectedArgs: (prompt: string) => string[]
  configure?: () => void
}

const originalHermesCommand = process.env.MECHBAY_HERMES_CMD

const CASES: Case[] = [
  {
    label: 'claude',
    Runner: ClaudeRunner as never,
    expectedCommand: 'claude',
    expectedArgs: () => ['-p', '--output-format', 'stream-json', '--verbose']
  },
  {
    label: 'codex',
    Runner: CodexRunner as never,
    expectedCommand: 'codex',
    expectedArgs: () => ['exec', '-']
  },
  {
    label: 'gemini',
    Runner: GeminiRunner as never,
    expectedCommand: 'gemini',
    expectedArgs: () => ['-o', 'text', '-y']
  },
  {
    label: 'hermes',
    Runner: HermesRunner as never,
    expectedCommand: 'custom-agent',
    expectedArgs: (p) => ['run', '--message', p],
    configure: () => {
      process.env.MECHBAY_HERMES_CMD = 'custom-agent run --message {PROMPT}'
    }
  }
]

function makeFakeChild(): EventEmitter & {
  stdout: Readable
  stderr: Readable
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable
    stderr: Readable
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = Readable.from([])
  child.stderr = Readable.from([])
  child.kill = vi.fn()
  return child
}

beforeEach(() => {
  delete process.env.MECHBAY_HERMES_CMD
})

afterEach(() => {
  if (originalHermesCommand === undefined) {
    delete process.env.MECHBAY_HERMES_CMD
  } else {
    process.env.MECHBAY_HERMES_CMD = originalHermesCommand
  }
})

describe.each(CASES)('$label runner', ({ Runner, expectedCommand, expectedArgs, configure }) => {
  beforeEach(() => {
    configure?.()
  })

  it('probes the right command for isAvailable', async () => {
    const probed: string[] = []
    const runner = new Runner({
      which: async (cmd: string) => {
        probed.push(cmd)
        return '/usr/local/bin/' + cmd
      }
    })
    expect(await runner.isAvailable()).toBe(true)
    expect(probed).toEqual([expectedCommand])
  })

  it('passes the correct argv to spawn()', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new Runner({
      which: async () => '/fake/' + expectedCommand,
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'say hi')
    expect(spawnCalls).toEqual([[expectedCommand, expectedArgs('say hi')]])
  })

  it('does not hang when spawn emits error (ENOENT)', async () => {
    const child = makeFakeChild()
    const runner = new Runner({
      which: async () => '/fake/' + expectedCommand,
      spawnProcess: (() => child) as never
    })
    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => child.emit('error', new Error(`spawn ${expectedCommand} ENOENT`)), 5)

    const chunks: string[] = []
    for await (const c of result.stream) chunks.push(c.text)
    expect(chunks.join('')).toContain('ENOENT')
    expect(await result.exit).toBe(-1)
  })
})

describe('CliRunner spawn safety', () => {
  it('uses the injected spawnProcess with shell disabled', async () => {
    const child = makeFakeChild()
    const spawnProcess = vi.fn(() => child)
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: spawnProcess as never
    })

    await runner.spawn('/tmp/project', 'say hi')

    expect(spawnProcess).toHaveBeenCalledWith(
      'claude',
      ['-p', '--output-format', 'stream-json', '--verbose'],
      {
        cwd: '/tmp/project',
        shell: false
      }
    )
  })
})
