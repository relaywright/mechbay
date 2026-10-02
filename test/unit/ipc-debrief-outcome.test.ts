import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import type { BrowserWindow } from 'electron'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner, SpawnResult } from '../../src/main/runners/types'
import type { AgentFamily, Companion, Deployment, Facility } from '../../src/shared/types'

/**
 * The debrief must say why a completed mission has no diff. "No git
 * repository" is only true when there is no repository at all; when a
 * baseline commit was captured, or the folder is a repository git could not
 * read (no commits yet, a malformed config, a git timeout), the outcome says
 * git could not read the project. The diff itself is mocked to be
 * unavailable; the repository check runs for real against real folders.
 */

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: { handle: vi.fn() },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

let baseline: string | null = null

vi.mock('../../src/main/git-diff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../src/main/git-diff')>()),
  captureGitBaseline: vi.fn(async () => baseline),
  computeDiffSummary: vi.fn(async () => null)
}))

import { executeDeployment } from '../../src/main/ipc'
import { makeLogSink } from '../helpers/log-sink'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

afterEach(async () => {
  baseline = null
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
}

/** Runs a mission that exits 0 in a fresh temp folder, after `prepare` sets that folder up. */
async function runCompletedMission(
  prepare: (dir: string) => Promise<void> = async () => {}
): Promise<Deployment | undefined> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mechbay-debrief-outcome-'))
  tempDirs.push(dir)
  await prepare(dir)
  const soulPath = path.join(dir, 'soul.md')
  const memoryPath = path.join(dir, 'memory.md')
  await writeFile(soulPath, '# Soul\n')
  await writeFile(memoryPath, '# Memory\n')

  const state = new StateManager(makeInMemoryStore(), dir)
  const companion: Companion = { ...state.getState().companions[0], soulPath, memoryPath }
  const facility: Facility = {
    id: 'facility-debrief',
    name: 'debrief-facility',
    path: dir,
    facilityType: 'research-lab',
    tile: { x: 8, y: 3 },
    source: 'manual',
    discoveredAt: Date.now()
  }
  const deployment: Deployment = {
    id: 'deployment-debrief',
    companionId: companion.id,
    facilityId: facility.id,
    taskPrompt: 'Do the thing',
    status: 'walking-to',
    startedAt: Date.now()
  }
  state.updateState((prev) => ({ ...prev, deployments: [deployment, ...prev.deployments] }))

  const done: SpawnResult = {
    stream: (async function* () {
      yield* []
    })(),
    abort: () => {},
    exit: Promise.resolve(0)
  }
  const runner: Runner = { isAvailable: async () => true, spawn: async () => done }
  const runners = { claude: runner, codex: runner, kimi: runner, gemini: runner, hermes: runner }

  await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
    win: { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
    state,
    runners: runners as Record<AgentFamily, Runner>,
    logs: makeLogSink().sink,
    fsReader: {} as never,
    secrets: { envFor: vi.fn(() => ({})), getSecret: vi.fn(() => null) } as never
  })

  return state.getState().deployments.find((d) => d.id === deployment.id)
}

async function gitInit(dir: string): Promise<void> {
  await execFileAsync('git', ['-C', dir, 'init', '-q'], { windowsHide: true })
}

/** True when a `.git` entry exists in `dir` or any folder above it. */
function gitEntryAbove(dir: string): boolean {
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return true
    if (path.dirname(current) === current) return false
  }
}

const UNAVAILABLE = 'Completed. The diff is unavailable because git could not read this project.'
const NO_REPOSITORY = 'Completed. (No git repository, so no diff is available.)'

// Real git runs for the repository check, which is slow under a busy suite.
describe('debrief outcome when no diff is available', { timeout: 20_000 }, () => {
  it('says git could not read the project when a baseline was captured', async () => {
    baseline = 'a'.repeat(40)

    const finished = await runCompletedMission()

    expect(finished?.status).toBe('completed')
    expect(finished?.summary).toBe(UNAVAILABLE)
  })

  it('says git could not read the project for a repository without commits', async () => {
    const finished = await runCompletedMission(gitInit)

    expect(finished?.summary).toBe(UNAVAILABLE)
  })

  it('never says "no git repository" when the repository config is malformed', async () => {
    const finished = await runCompletedMission(async (dir) => {
      await gitInit(dir)
      await writeFile(path.join(dir, '.git', 'config'), '[core\n\tbroken = = =\n')
    })

    expect(finished?.summary).toBe(UNAVAILABLE)
    expect(finished?.summary).not.toBe(NO_REPOSITORY)
  })

  it.skipIf(gitEntryAbove(tmpdir()))(
    'says there is no git repository only when there is none (skipped when the temp folder sits inside a repo)',
    async () => {
      const finished = await runCompletedMission()

      expect(finished?.summary).toBe(NO_REPOSITORY)
    }
  )
})
