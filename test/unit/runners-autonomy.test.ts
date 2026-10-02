import { EventEmitter } from 'events'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeRunner } from '../../src/main/runners/claude'
import { CodexRunner } from '../../src/main/runners/codex'
import { GeminiRunner } from '../../src/main/runners/gemini'
import { autonomyRaisedBy, autonomySupport, effectiveAutonomy } from '../../src/shared/autonomy'
import type { AgentFamily } from '../../src/shared/types'

function fakeSpawn(): { calls: { cmd: string; args: string[] }[]; spawnProcess: never } {
  const calls: { cmd: string; args: string[] }[] = []
  const spawnProcess = vi.fn((cmd: string, args: string[]) => {
    calls.push({ cmd, args })
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      stdin: { on: vi.fn(), write: vi.fn(), end: vi.fn() },
      kill: vi.fn(),
      pid: 4242,
      exitCode: null,
      signalCode: null
    })
    queueMicrotask(() => child.emit('close'))
    return child
  })
  return { calls, spawnProcess: spawnProcess as never }
}

const which = async (): Promise<string> => '/usr/bin/x'

describe('Claude autonomy flags', () => {
  it.each([
    ['read', 'plan'],
    ['edit', 'acceptEdits'],
    ['full', 'bypassPermissions']
  ] as const)('%s runs with --permission-mode %s', async (level, mode) => {
    const { calls, spawnProcess } = fakeSpawn()
    await new ClaudeRunner({ which, spawnProcess }).spawn('/w', 'task', {
      autonomy: level,
      model: 'claude-haiku-4-5'
    })
    expect(calls[0].args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      mode,
      '--model',
      'claude-haiku-4-5'
    ])
  })

  it('defaults to Edit files when no level is given', async () => {
    const { calls, spawnProcess } = fakeSpawn()
    await new ClaudeRunner({ which, spawnProcess }).spawn('/w', 'task')
    expect(calls[0].args).toContain('acceptEdits')
  })

  it('places profile arguments before the model', async () => {
    const { calls, spawnProcess } = fakeSpawn()
    await new ClaudeRunner({
      which,
      spawnProcess,
      profileArgs: ['--setting-sources', 'project,local']
    }).spawn('/w', 't', { autonomy: 'edit' })
    expect(calls[0].args).toEqual([
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      'acceptEdits',
      '--setting-sources',
      'project,local'
    ])
  })
})

describe('Codex autonomy flags', () => {
  it.each([
    ['read', 'read-only'],
    ['edit', 'workspace-write'],
    ['full', 'danger-full-access']
  ] as const)(
    '%s on Windows runs with --sandbox %s and the unelevated sandbox',
    async (level, sandbox) => {
      const { calls, spawnProcess } = fakeSpawn()
      await new CodexRunner({ which, spawnProcess, platform: 'win32' }).spawn('C:\\w', 'task', {
        autonomy: level,
        model: 'gpt-6-astra'
      })
      expect(calls[0].args).toEqual([
        'exec',
        '--sandbox',
        sandbox,
        '--skip-git-repo-check',
        '-c',
        'windows.sandbox=unelevated',
        '-m',
        'gpt-6-astra',
        '-'
      ])
    }
  )

  it('omits the Windows sandbox override elsewhere and keeps stdin last', async () => {
    const { calls, spawnProcess } = fakeSpawn()
    await new CodexRunner({
      which,
      spawnProcess,
      platform: 'linux',
      profileArgs: ['--ignore-user-config', '--ignore-rules']
    }).spawn('/w', 't', { autonomy: 'edit' })
    expect(calls[0].args).toEqual([
      'exec',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '-'
    ])
  })
})

describe('Gemini', () => {
  it('keeps its approve-everything flag whatever level is stored', async () => {
    const { calls, spawnProcess } = fakeSpawn()
    await new GeminiRunner({ which, spawnProcess }).spawn('/w', 't', { autonomy: 'read' })
    expect(calls[0].args).toEqual(['-o', 'text', '-y'])
  })
})

describe('autonomy support matrix', () => {
  it('enforces every level on Claude and Codex', () => {
    for (const rt of ['claude', 'codex'] as const) {
      expect(autonomySupport(rt)).toMatchObject({
        enforced: true,
        available: { read: true, edit: true, full: true }
      })
    }
  })

  it('offers only Full on Gemini, with the reason', () => {
    expect(autonomySupport('gemini')).toMatchObject({
      enforced: true,
      available: { read: false, edit: false, full: true }
    })
    expect(autonomySupport('gemini').reason).toMatch(/every action approved/)
    expect(effectiveAutonomy('gemini', 'edit')).toBe('full')
  })

  it('says plainly that Kimi and Hermes cannot be limited', () => {
    for (const rt of ['kimi', 'hermes'] as const) {
      expect(autonomySupport(rt).enforced).toBe(false)
      expect(effectiveAutonomy(rt, 'read')).toBeNull()
    }
  })

  it('uses no em dashes in any user-facing string', async () => {
    const mod = await import('../../src/shared/autonomy')
    const strings = JSON.stringify([
      mod.AUTONOMY_LABELS,
      mod.AUTONOMY_HINTS,
      mod.USER_RULES_NOTE,
      ...(['claude', 'codex', 'gemini', 'kimi', 'hermes'] as const).map(
        (r) => mod.autonomySupport(r).reason ?? ''
      )
    ])
    expect(strings).not.toContain('\u2014')
  })
})

describe('autonomyRaisedBy (runtime switch)', () => {
  it('reports the higher level a switch would run at', () => {
    expect(autonomyRaisedBy('claude', 'gemini', 'read')).toBe('full')
    expect(autonomyRaisedBy('codex', 'kimi', 'full')).toBe('unenforced')
    expect(autonomyRaisedBy('gemini', 'hermes', 'edit')).toBe('unenforced')
  })

  it('is undefined when the level stays the same or drops', () => {
    expect(autonomyRaisedBy('claude', 'codex', 'read')).toBeUndefined()
    expect(autonomyRaisedBy('claude', 'gemini', 'full')).toBeUndefined()
    expect(autonomyRaisedBy('gemini', 'claude', 'edit')).toBeUndefined()
    expect(autonomyRaisedBy('kimi', 'claude', 'read')).toBeUndefined()
  })

  it('treats an unknown runtime from a damaged save as not enforced instead of crashing', () => {
    const bogus = 'toString' as AgentFamily
    expect(autonomySupport(bogus).enforced).toBe(false)
    expect(effectiveAutonomy(bogus, 'read')).toBeNull()
  })
})
