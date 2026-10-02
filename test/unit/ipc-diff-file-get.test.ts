import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { AgentFamily, Deployment, Facility } from '../../src/shared/types'
import type { Runner } from '../../src/main/runners/types'

const execFileAsync = promisify(execFile)
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler)
    )
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

import { registerIpc } from '../../src/main/ipc'

async function runGit(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, ...args], { windowsHide: true })
}

async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'mechbay-diff-file-get-'))
  await runGit(repoPath, ['init'])
  await runGit(repoPath, ['config', 'user.email', 'test@mechbay.local'])
  await runGit(repoPath, ['config', 'user.name', 'MechBay Test'])
  await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nline two\n')
  await runGit(repoPath, ['add', 'tracked.txt'])
  await runGit(repoPath, ['commit', '-m', 'initial'])
  return repoPath
}

function setup(): {
  state: StateManager
  call: (payload: { deploymentId: string; path: string }) => Promise<unknown>
} {
  const data: Record<string, unknown> = {}
  const store: StoreLike = {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
  const state = new StateManager(store, '/tmp/ipc-diff-file-get')
  const runner: Runner = { isAvailable: async () => true, spawn: vi.fn() }
  const runners = Object.fromEntries(
    (['claude', 'codex', 'kimi', 'gemini', 'hermes'] as AgentFamily[]).map((family) => [
      family,
      runner
    ])
  ) as Record<AgentFamily, Runner>

  registerIpc({
    win: { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
    state,
    runners,
    fsReader: {} as never,
    secrets: {} as never
  })

  const handler = handlers.get(IPC.DIFF_FILE_GET)
  if (!handler) throw new Error('DIFF_FILE_GET handler missing')
  return { state, call: (payload) => Promise.resolve(handler({}, payload)) }
}

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// These tests drive real git subprocesses. Each spawn costs a few hundred ms
// on Windows, so under a full parallel suite run a test can pass Vitest's
// 5 s default without anything being wrong.
const GIT_TEST_TIMEOUT_MS = 20_000

describe('IPC.DIFF_FILE_GET', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  beforeEach(() => handlers.clear())

  it('rejects an unknown deployment id', async () => {
    const { call } = setup()

    const result = await call({ deploymentId: 'does-not-exist', path: 'tracked.txt' })

    expect(result).toEqual({ ok: false, error: 'Deployment not found: does-not-exist' })
  })

  it("rejects a path that is not in the deployment's own diffFiles, without touching git", async () => {
    const repoPath = await makeRepo()
    tempDirs.push(repoPath)
    const { state, call } = setup()

    const facility: Facility = {
      id: 'facility-1',
      name: 'Test Facility',
      path: repoPath,
      facilityType: 'foundry',
      tile: { x: 0, y: 0 },
      source: 'manual',
      discoveredAt: Date.now()
    }
    const deployment: Deployment = {
      id: 'deploy-1',
      companionId: 'companion-1',
      facilityId: facility.id,
      taskPrompt: 'do something',
      status: 'completed',
      startedAt: Date.now(),
      diffFiles: [{ path: 'tracked.txt', insertions: 1, deletions: 0 }]
    }
    state.updateState((prev) => ({
      ...prev,
      facilities: [...prev.facilities, facility],
      deployments: [deployment, ...prev.deployments]
    }))

    const traversal = await call({ deploymentId: 'deploy-1', path: '../secrets.txt' })
    const notInDiff = await call({ deploymentId: 'deploy-1', path: 'other.txt' })

    expect(traversal).toEqual({
      ok: false,
      error: 'That path is not part of this deployment’s diff'
    })
    expect(notInDiff).toEqual({
      ok: false,
      error: 'That path is not part of this deployment’s diff'
    })
  })

  it('returns a real patch for a file that is in diffFiles (happy path)', async () => {
    const repoPath = await makeRepo()
    tempDirs.push(repoPath)
    const { state, call } = setup()

    const facility: Facility = {
      id: 'facility-2',
      name: 'Test Facility',
      path: repoPath,
      facilityType: 'foundry',
      tile: { x: 0, y: 0 },
      source: 'manual',
      discoveredAt: Date.now()
    }
    const baselineSha = (
      await execFileAsync('git', ['-C', repoPath, 'rev-parse', 'HEAD'], { windowsHide: true })
    ).stdout.trim()

    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nupdated line\n')

    const deployment: Deployment = {
      id: 'deploy-2',
      companionId: 'companion-1',
      facilityId: facility.id,
      taskPrompt: 'do something',
      status: 'completed',
      startedAt: Date.now(),
      baselineSha,
      diffFiles: [{ path: 'tracked.txt', insertions: 1, deletions: 1 }]
    }
    state.updateState((prev) => ({
      ...prev,
      facilities: [...prev.facilities, facility],
      deployments: [deployment, ...prev.deployments]
    }))

    const result = await call({ deploymentId: 'deploy-2', path: 'tracked.txt' })

    expect(result).toMatchObject({ ok: true })
    const patch = (result as { ok: true; patch: { hunks: unknown[] } }).patch
    expect(patch.hunks.length).toBeGreaterThan(0)
  })

  it('rejects when the facility is missing or unlinked', async () => {
    const { state, call } = setup()

    const deployment: Deployment = {
      id: 'deploy-3',
      companionId: 'companion-1',
      facilityId: 'missing-facility',
      taskPrompt: 'do something',
      status: 'completed',
      startedAt: Date.now(),
      diffFiles: [{ path: 'tracked.txt', insertions: 1, deletions: 0 }]
    }
    state.updateState((prev) => ({ ...prev, deployments: [deployment, ...prev.deployments] }))

    const result = await call({ deploymentId: 'deploy-3', path: 'tracked.txt' })

    expect(result).toEqual({ ok: false, error: 'Facility is missing or unlinked' })
  })
})
