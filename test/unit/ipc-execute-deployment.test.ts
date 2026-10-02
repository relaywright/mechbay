import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner, RunnerSpawnOptions, SpawnResult } from '../../src/main/runners/types'
import type { AgentFamily, Companion, Deployment } from '../../src/shared/types'

/**
 * executeDeployment must pick the companion's runtime override over its
 * native family when both are set — the whole point of "any mech, any
 * runtime". Electron is mocked so importing ipc.ts (which imports
 * ipcMain/dialog/BrowserWindow) works outside a real Electron process.
 */

vi.mock('electron', () => ({
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

// vitest hoists vi.mock() above imports, so executeDeployment below picks
// up the mocked 'electron' module even though this import comes after it.
import { executeDeployment } from '../../src/main/ipc'
import { makeLogSink } from '../helpers/log-sink'
import { MissionRegistry } from '../../src/main/mission-registry'

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v
    },
    has: (k: string) => k in data
  }
}

function makeFakeWin(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

interface SpawnCall {
  cwd: string
  prompt: string
  options?: RunnerSpawnOptions
}

function recordingRunner(calls: SpawnCall[]): Runner {
  return {
    isAvailable: async () => true,
    spawn: async (
      cwd: string,
      prompt: string,
      options?: RunnerSpawnOptions
    ): Promise<SpawnResult> => {
      calls.push({ cwd, prompt, options })
      return {
        stream: (async function* () {
          yield* []
        })(),
        abort: async () => {},
        exit: Promise.resolve(0)
      }
    }
  }
}

const tempDirs: string[] = []

async function makeBarracks(): Promise<{ soulPath: string; memoryPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mechbay-execute-deployment-'))
  tempDirs.push(dir)
  const soulPath = path.join(dir, 'soul.md')
  const memoryPath = path.join(dir, 'memory.md')
  await writeFile(soulPath, '# Soul\nA steady, methodical mech.\n')
  await writeFile(memoryPath, '# Memory\n(empty)\n')
  return { soulPath, memoryPath }
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('executeDeployment runtime selection', () => {
  it('uses runners[runtime] instead of runners[family] when a runtime override is set', async () => {
    const facilityDir = await mkdtemp(path.join(tmpdir(), 'mechbay-execute-deployment-facility-'))
    tempDirs.push(facilityDir)
    const { soulPath, memoryPath } = await makeBarracks()

    const claudeCalls: SpawnCall[] = []
    const codexCalls: SpawnCall[] = []
    const runners: Record<AgentFamily, Runner> = {
      claude: recordingRunner(claudeCalls),
      codex: recordingRunner(codexCalls),
      kimi: recordingRunner([]),
      gemini: recordingRunner([]),
      hermes: recordingRunner([])
    }

    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/execute-deployment-runtime-test')

    const companion: Companion = {
      id: 'companion-atlas-test',
      family: 'claude',
      runtime: 'codex',
      model: 'gpt-5.6-terra',
      mechClass: 'atlas',
      name: 'Atlas-Prime',
      spriteKey: 'mech-atlas',
      homeTile: { x: 4, y: 10 },
      cliAvailable: true,
      soulPath,
      memoryPath,
      autonomy: 'edit'
    }
    const facility = {
      id: 'facility-test',
      name: 'test-facility',
      path: facilityDir,
      facilityType: 'research-lab' as const,
      tile: { x: 8, y: 3 },
      source: 'manual' as const,
      discoveredAt: Date.now()
    }

    await executeDeployment('deployment-1', companion, facility, 'Refactor the module', {
      win: makeFakeWin(),
      state,
      runners,
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
      secrets: {
        envFor: vi.fn(() => ({ OPENAI_API_KEY: 'stored-key' })),
        getSecret: vi.fn(() => null)
      } as never
    })

    expect(claudeCalls).toHaveLength(0)
    expect(codexCalls).toHaveLength(1)
    expect(codexCalls[0].cwd).toBe(facilityDir)
    expect(codexCalls[0].options).toEqual({
      model: 'gpt-5.6-terra',
      env: { OPENAI_API_KEY: 'stored-key' },
      autonomy: 'edit'
    })
  })
})

describe('executeDeployment Autonomy (P0-12)', () => {
  const STORED_KEY = 'sk-ant-stored-key-0123456789'

  async function run(
    companionPatch: Partial<Companion>,
    result: Partial<SpawnResult> = {}
  ): Promise<{
    calls: SpawnCall[]
    deployment: Deployment
    logLines: string[]
  }> {
    const facilityDir = await mkdtemp(path.join(tmpdir(), 'mechbay-execute-deployment-facility-'))
    tempDirs.push(facilityDir)
    const { soulPath, memoryPath } = await makeBarracks()
    const calls: SpawnCall[] = []
    const runner: Runner = {
      isAvailable: async () => true,
      spawn: async (cwd, prompt, options) => {
        calls.push({ cwd, prompt, options })
        return {
          stream: (async function* () {
            yield* []
          })(),
          abort: async () => {},
          exit: Promise.resolve(0),
          ...result
        }
      }
    }
    const runners: Record<AgentFamily, Runner> = {
      claude: runner,
      codex: runner,
      kimi: runner,
      gemini: runner,
      hermes: runner
    }
    const state = new StateManager(makeInMemoryStore(), '/tmp/execute-deployment-autonomy-test')
    const companion: Companion = {
      id: 'companion-autonomy-test',
      family: 'claude',
      mechClass: 'atlas',
      name: 'Atlas-Prime',
      spriteKey: 'mech-atlas',
      homeTile: { x: 4, y: 10 },
      cliAvailable: true,
      soulPath,
      memoryPath,
      autonomy: 'edit',
      ...companionPatch
    }
    const facility = {
      id: 'facility-test',
      name: 'test-facility',
      path: facilityDir,
      facilityType: 'research-lab' as const,
      tile: { x: 8, y: 3 },
      source: 'manual' as const,
      discoveredAt: Date.now()
    }
    state.updateState((prev) => ({
      ...prev,
      deployments: [
        {
          id: 'deployment-autonomy',
          companionId: companion.id,
          facilityId: facility.id,
          taskPrompt: 'Run the tests',
          status: 'walking-to',
          startedAt: Date.now()
        },
        ...prev.deployments
      ]
    }))
    const logs = makeLogSink()

    await executeDeployment('deployment-autonomy', companion, facility, 'Run the tests', {
      win: makeFakeWin(),
      state,
      runners,
      missions: new MissionRegistry(),
      logs: logs.sink,
      fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
      secrets: {
        envFor: vi.fn(() => ({ ANTHROPIC_API_KEY: STORED_KEY })),
        getSecret: vi.fn((runtime: AgentFamily) => (runtime === 'claude' ? STORED_KEY : null))
      } as never
    })

    const deployment = state.getState().deployments.find((d) => d.id === 'deployment-autonomy')!
    return { calls, deployment, logLines: logs.entries.map((e) => e.text) }
  }

  it("passes the mech's Autonomy level to the runner and records it", async () => {
    const { calls, deployment } = await run({ autonomy: 'read' })
    expect(calls[0].options?.autonomy).toBe('read')
    expect(deployment.autonomy).toBe('read')
    expect(deployment.status).toBe('completed')
  })

  it('records the level Gemini actually runs at, not the stored one', async () => {
    const { calls, deployment } = await run({ runtime: 'gemini', autonomy: 'edit' })
    expect(calls[0].options?.autonomy).toBe('full')
    expect(deployment.autonomy).toBe('full')
  })

  it('records unenforced for Hermes', async () => {
    const { calls, deployment } = await run({ runtime: 'hermes', autonomy: 'read' })
    expect(calls[0].options?.autonomy).toBeUndefined()
    expect(deployment.autonomy).toBe('unenforced')
  })

  it('falls back to Edit files for a mech saved without a level', async () => {
    const { calls, deployment } = await run({ autonomy: undefined as never })
    expect(calls[0].options?.autonomy).toBe('edit')
    expect(deployment.autonomy).toBe('edit')
  })

  it('records denials from the runner report', async () => {
    const { deployment } = await run(
      {},
      { report: () => ({ permissionDenials: ['PowerShell: npm test'] }) }
    )
    expect(deployment.permissionDenials).toEqual(['PowerShell: npm test'])
  })

  it('leaves permissionDenials off when nothing was blocked', async () => {
    const { deployment } = await run({}, { report: () => ({ permissionDenials: [] }) })
    expect(deployment).not.toHaveProperty('permissionDenials')
  })

  it('redacts a configured API key inside a denial label before saving or logging it', async () => {
    const label = `Bash: curl -H "x-api-key: ${STORED_KEY}" https://api.example.com`
    const { deployment, logLines } = await run(
      {},
      {
        // The real Claude formatter prints each denial as a log line too.
        stream: (async function* () {
          yield { stream: 'stdout' as const, text: `DENIED · ${label}\n` }
        })(),
        report: () => ({ permissionDenials: [label] })
      }
    )
    expect(deployment.permissionDenials).toEqual([
      'Bash: curl -H "x-api-key: [redacted]" https://api.example.com'
    ])
    expect(JSON.stringify(deployment)).not.toContain(STORED_KEY)
    expect(logLines.join('\n')).toContain('DENIED · Bash: curl -H "x-api-key: [redacted]"')
    expect(logLines.join('\n')).not.toContain(STORED_KEY)
  })
})
