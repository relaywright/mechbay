import { describe, it, expect, vi, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner, RunnerSpawnOptions, SpawnResult } from '../../src/main/runners/types'
import type { AgentFamily, Companion } from '../../src/shared/types'

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
        abort: () => {},
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
      recentDeploymentIds: [],
      soulPath,
      memoryPath
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
      env: { OPENAI_API_KEY: 'stored-key' }
    })
  })
})
