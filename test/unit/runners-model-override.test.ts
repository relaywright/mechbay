import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { ClaudeRunner } from '../../src/main/runners/claude'
import { CodexRunner } from '../../src/main/runners/codex'
import { GeminiRunner } from '../../src/main/runners/gemini'
import { KimiRunner } from '../../src/main/runners/kimi'

/**
 * Model pass-through: RunnerSpawnOptions.model threads through spawn() into
 * each CLI-backed runner's argv. Locks in the exact flag each runtime
 * expects, and confirms the flag is entirely absent when no model is set
 * (so we never pass `--model undefined` or similar).
 */

function makeFakeChild(): EventEmitter & {
  stdout: Readable
  stderr: Readable
  stdin: {
    write: ReturnType<typeof vi.fn>
    end: ReturnType<typeof vi.fn>
    on: ReturnType<typeof vi.fn>
  }
  kill: ReturnType<typeof vi.fn>
} {
  const child = new EventEmitter() as EventEmitter & {
    stdout: Readable
    stderr: Readable
    stdin: {
      write: ReturnType<typeof vi.fn>
      end: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    kill: ReturnType<typeof vi.fn>
  }
  child.stdout = Readable.from([])
  child.stderr = Readable.from([])
  child.stdin = { write: vi.fn(), end: vi.fn(), on: vi.fn() }
  child.kill = vi.fn()
  return child
}

describe('ClaudeRunner model pass-through', () => {
  it('appends --model <model> when a model override is set', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'say hi', { model: 'claude-opus-4-8' })
    expect(spawnCalls).toEqual([
      [
        'claude',
        [
          '-p',
          '--output-format',
          'stream-json',
          '--verbose',
          '--permission-mode',
          'acceptEdits',
          '--model',
          'claude-opus-4-8'
        ]
      ]
    ])
    expect(child.stdin.write).toHaveBeenCalledWith('say hi')
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('omits --model entirely when no override is set', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'say hi')
    expect(spawnCalls).toEqual([
      [
        'claude',
        ['-p', '--output-format', 'stream-json', '--verbose', '--permission-mode', 'acceptEdits']
      ]
    ])
    expect(child.stdin.write).toHaveBeenCalledWith('say hi')
    expect(child.stdin.end).toHaveBeenCalled()
  })
})

describe('CodexRunner model pass-through', () => {
  it('inserts -m <model> between exec and the stdin sentinel', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new CodexRunner({
      which: async () => '/fake/codex',
      platform: 'linux',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'refactor this', { model: 'gpt-5.6-terra' })
    expect(spawnCalls).toEqual([
      [
        'codex',
        [
          'exec',
          '--sandbox',
          'workspace-write',
          '--skip-git-repo-check',
          '-m',
          'gpt-5.6-terra',
          '-'
        ]
      ]
    ])
    expect(child.stdin.write).toHaveBeenCalledWith('refactor this')
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('omits -m entirely when no override is set', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new CodexRunner({
      which: async () => '/fake/codex',
      platform: 'linux',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'refactor this')
    expect(spawnCalls).toEqual([
      ['codex', ['exec', '--sandbox', 'workspace-write', '--skip-git-repo-check', '-']]
    ])
    expect(child.stdin.write).toHaveBeenCalledWith('refactor this')
    expect(child.stdin.end).toHaveBeenCalled()
  })
})

describe('GeminiRunner model pass-through', () => {
  it('appends -m <model> after the existing flags', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new GeminiRunner({
      which: async () => '/fake/gemini',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'summarize', { model: 'gemini-3-pro' })
    expect(spawnCalls).toEqual([['gemini', ['-o', 'text', '-y', '-m', 'gemini-3-pro']]])
    expect(child.stdin.write).toHaveBeenCalledWith('summarize')
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('omits -m entirely when no override is set', async () => {
    const spawnCalls: Array<[string, string[]]> = []
    const child = makeFakeChild()
    const runner = new GeminiRunner({
      which: async () => '/fake/gemini',
      spawnProcess: ((cmd: string, args: string[]) => {
        spawnCalls.push([cmd, args])
        return child
      }) as never
    })

    await runner.spawn('/tmp', 'summarize')
    expect(spawnCalls).toEqual([['gemini', ['-o', 'text', '-y']]])
    expect(child.stdin.write).toHaveBeenCalledWith('summarize')
    expect(child.stdin.end).toHaveBeenCalled()
  })
})

describe('KimiRunner model pass-through', () => {
  const SCRIPT = '/fake/abs/path/kimi_fireworks.py'

  it('appends --model <model> after --narrate', async () => {
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

    await runner.spawn('/tmp', 'explore', { model: 'kimi-k3' })
    expect(spawnCalls).toEqual([['python', [SCRIPT, '-', '-v', '--narrate', '--model', 'kimi-k3']]])
  })

  it('omits --model entirely when no override is set', async () => {
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

    await runner.spawn('/tmp', 'explore')
    expect(spawnCalls).toEqual([['python', [SCRIPT, '-', '-v', '--narrate']]])
  })
})

describe('CliRunner environment pass-through', () => {
  it('merges explicit spawn env over process.env', async () => {
    const child = makeFakeChild()
    const spawnProcess = vi.fn((..._args: unknown[]) => child)
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: spawnProcess as never
    })
    const previous = process.env.MECHBAY_RUNNER_ENV_TEST
    process.env.MECHBAY_RUNNER_ENV_TEST = 'inherited'
    try {
      await runner.spawn('/tmp', 'say hi', {
        env: { MECHBAY_RUNNER_ENV_TEST: 'stored', GEMINI_API_KEY: 'secret' }
      })
      expect(spawnProcess.mock.calls[0][2]).toMatchObject({
        env: expect.objectContaining({
          MECHBAY_RUNNER_ENV_TEST: 'stored',
          GEMINI_API_KEY: 'secret'
        })
      })
    } finally {
      if (previous === undefined) delete process.env.MECHBAY_RUNNER_ENV_TEST
      else process.env.MECHBAY_RUNNER_ENV_TEST = previous
    }
  })

  it('does not pass an env option when no explicit env is supplied', async () => {
    const child = makeFakeChild()
    const spawnProcess = vi.fn((..._args: unknown[]) => child)
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: spawnProcess as never
    })
    await runner.spawn('/tmp', 'say hi')
    expect(spawnProcess.mock.calls[0][2]).toEqual({ cwd: '/tmp', shell: false })
  })
})
