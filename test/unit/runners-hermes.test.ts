import { afterEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { HermesRunner, tokenizeHermesCommand } from '../../src/main/runners/hermes'

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

const originalHermesCommand = process.env.MECHBAY_HERMES_CMD

afterEach(() => {
  if (originalHermesCommand === undefined) {
    delete process.env.MECHBAY_HERMES_CMD
  } else {
    process.env.MECHBAY_HERMES_CMD = originalHermesCommand
  }
})

describe('HermesRunner (bring-your-own agent)', () => {
  it('is unavailable when MECHBAY_HERMES_CMD is unset', async () => {
    delete process.env.MECHBAY_HERMES_CMD
    const which = vi.fn()

    expect(await new HermesRunner({ which }).isAvailable()).toBe(false)
    expect(which).not.toHaveBeenCalled()
  })

  it('is unavailable when its configured binary is not on PATH', async () => {
    process.env.MECHBAY_HERMES_CMD = 'missing-agent run'
    const which = vi.fn().mockResolvedValue(null)

    expect(await new HermesRunner({ which }).isAvailable()).toBe(false)
    expect(which).toHaveBeenCalledWith('missing-agent')
  })

  it('is available when its configured binary resolves on PATH', async () => {
    process.env.MECHBAY_HERMES_CMD = 'custom-agent run'
    const which = vi.fn().mockResolvedValue('/usr/local/bin/custom-agent')

    expect(await new HermesRunner({ which }).isAvailable()).toBe(true)
    expect(which).toHaveBeenCalledWith('custom-agent')
  })

  it('substitutes every {PROMPT} token occurrence into argv', async () => {
    process.env.MECHBAY_HERMES_CMD = 'custom-agent --message "{PROMPT}" --repeat={PROMPT}:{PROMPT}'
    const child = makeFakeChild()
    const spawnCalls: Array<[string, string[], { cwd?: string; shell?: boolean }]> = []
    const runner = new HermesRunner({
      which: async () => '/fake/custom-agent',
      spawnProcess: ((
        command: string,
        args: string[],
        options: { cwd?: string; shell?: boolean }
      ) => {
        spawnCalls.push([command, args, options])
        return child
      }) as never
    })
    const prompt = 'Explain "quoted" text with spaces.'

    await runner.spawn('/facility/path', prompt)

    expect(spawnCalls).toEqual([
      [
        'custom-agent',
        ['--message', prompt, `--repeat=${prompt}:${prompt}`],
        { cwd: '/facility/path', shell: false, detached: process.platform !== 'win32' }
      ]
    ])
    expect(child.stdin.write).not.toHaveBeenCalled()
    expect(child.stdin.end).not.toHaveBeenCalled()
  })

  it('delivers the prompt through stdin when no {PROMPT} token is configured', async () => {
    process.env.MECHBAY_HERMES_CMD = 'custom-agent run --non-interactive'
    const child = makeFakeChild()
    const runner = new HermesRunner({
      which: async () => '/fake/custom-agent',
      spawnProcess: (() => child) as never
    })
    const prompt = 'Review the project and summarize the result.'

    await runner.spawn('/facility/path', prompt)

    expect(child.stdin.write).toHaveBeenCalledWith(prompt)
    expect(child.stdin.end).toHaveBeenCalled()
  })

  it('keeps quoted executable paths together while tokenizing', () => {
    expect(tokenizeHermesCommand('"C:\\Program Files\\agent\\agent.exe" run')).toEqual([
      'C:\\Program Files\\agent\\agent.exe',
      'run'
    ])
  })

  describe('{MODEL} placeholder substitution', () => {
    it('substitutes {MODEL} into argv when a model override is set', async () => {
      process.env.MECHBAY_HERMES_CMD = 'custom-agent --message {PROMPT} --model {MODEL}'
      const child = makeFakeChild()
      const spawnCalls: Array<[string, string[]]> = []
      const runner = new HermesRunner({
        which: async () => '/fake/custom-agent',
        spawnProcess: ((command: string, args: string[]) => {
          spawnCalls.push([command, args])
          return child
        }) as never
      })

      await runner.spawn('/facility/path', 'do the thing', { model: 'my-custom-model' })

      expect(spawnCalls).toEqual([
        ['custom-agent', ['--message', 'do the thing', '--model', 'my-custom-model']]
      ])
    })

    it('drops the {MODEL} token cleanly when no model override is set', async () => {
      process.env.MECHBAY_HERMES_CMD = 'custom-agent --message {PROMPT} --model {MODEL}'
      const child = makeFakeChild()
      const spawnCalls: Array<[string, string[]]> = []
      const runner = new HermesRunner({
        which: async () => '/fake/custom-agent',
        spawnProcess: ((command: string, args: string[]) => {
          spawnCalls.push([command, args])
          return child
        }) as never
      })

      await runner.spawn('/facility/path', 'do the thing')

      expect(spawnCalls).toEqual([['custom-agent', ['--message', 'do the thing', '--model']]])
    })

    it('ignores a model override silently when the command has no {MODEL} placeholder', async () => {
      process.env.MECHBAY_HERMES_CMD = 'custom-agent --message {PROMPT}'
      const child = makeFakeChild()
      const spawnCalls: Array<[string, string[]]> = []
      const runner = new HermesRunner({
        which: async () => '/fake/custom-agent',
        spawnProcess: ((command: string, args: string[]) => {
          spawnCalls.push([command, args])
          return child
        }) as never
      })

      await runner.spawn('/facility/path', 'do the thing', { model: 'unused-model' })

      expect(spawnCalls).toEqual([['custom-agent', ['--message', 'do the thing']]])
    })

    it('a token that is only {MODEL} disappears entirely when unset (no stray empty arg)', async () => {
      process.env.MECHBAY_HERMES_CMD = 'custom-agent {MODEL} --message {PROMPT}'
      const child = makeFakeChild()
      const spawnCalls: Array<[string, string[]]> = []
      const runner = new HermesRunner({
        which: async () => '/fake/custom-agent',
        spawnProcess: ((command: string, args: string[]) => {
          spawnCalls.push([command, args])
          return child
        }) as never
      })

      await runner.spawn('/facility/path', 'do the thing')

      expect(spawnCalls).toEqual([['custom-agent', ['--message', 'do the thing']]])
    })
  })
})
