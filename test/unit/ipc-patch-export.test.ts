import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager } from '../../src/main/state-manager'
import type { Deployment, Facility, PatchExportResult } from '../../src/shared/types'
import { MissionRegistry } from '../../src/main/mission-registry'
import { makeInMemoryStore, makeFakeWin, runnersFor, fakeFsReader } from '../helpers/ipc-harness'
import { makeLogSink } from '../helpers/log-sink'
import type { Runner } from '../../src/main/runners/types'

const execFileAsync = promisify(execFile)
const handlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
const electron = vi.hoisted(() => ({
  clipboard: { writeText: vi.fn() },
  dialog: { showOpenDialog: vi.fn(), showSaveDialog: vi.fn() },
  app: { getPath: vi.fn(() => '/tmp/mechbay-documents') }
}))

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) =>
      handlers.set(channel, handler)
    )
  },
  clipboard: electron.clipboard,
  dialog: electron.dialog,
  app: electron.app,
  BrowserWindow: class {}
}))

import { registerIpc } from '../../src/main/ipc'

async function runGit(repoPath: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], { windowsHide: true })
  return stdout
}

async function makeRepo(): Promise<{ repoPath: string; baselineSha: string }> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'mechbay-patch-export-'))
  await runGit(repoPath, ['init', '-q'])
  await runGit(repoPath, ['config', 'user.email', 'test@mechbay.local'])
  await runGit(repoPath, ['config', 'user.name', 'MechBay Test'])
  await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nline two\n')
  await runGit(repoPath, ['add', 'tracked.txt'])
  await runGit(repoPath, ['commit', '-q', '-m', 'initial'])
  const baselineSha = (await runGit(repoPath, ['rev-parse', 'HEAD'])).trim()
  return { repoPath, baselineSha }
}

function setup(): {
  state: StateManager
  call: (payload: unknown) => Promise<PatchExportResult>
} {
  const state = new StateManager(makeInMemoryStore(), '/tmp/ipc-patch-export')
  const runner: Runner = { isAvailable: async () => true, spawn: vi.fn() }
  registerIpc({
    win: makeFakeWin(),
    state,
    runners: runnersFor(runner),
    missions: new MissionRegistry(),
    logs: makeLogSink().sink,
    fsReader: fakeFsReader,
    secrets: {} as never
  })
  const handler = handlers.get(IPC.DIFF_PATCH_EXPORT)
  if (!handler) throw new Error('DIFF_PATCH_EXPORT handler missing')
  return { state, call: (payload) => Promise.resolve(handler({}, payload)) as never }
}

/** A finished mission in `repoPath` whose agent edited tracked.txt and added notes.md. */
function seedMission(state: StateManager, repoPath: string, baselineSha: string): void {
  const facility: Facility = {
    id: 'facility-1',
    name: 'Reactor Control',
    path: repoPath,
    facilityType: 'foundry',
    tile: { x: 0, y: 0 },
    source: 'manual',
    discoveredAt: Date.now()
  }
  const deployment: Deployment = {
    id: 'deploy-1',
    companionId: state.getState().companions[0].id,
    facilityId: facility.id,
    taskPrompt: 'Update the notes',
    status: 'completed',
    startedAt: 1_000,
    completedAt: 61_000,
    baselineSha,
    diffStats: { filesChanged: 2, insertions: 2, deletions: 1 },
    diffFiles: [
      { path: 'tracked.txt', insertions: 1, deletions: 1 },
      { path: 'notes.md', insertions: 1, deletions: 0 }
    ]
  }
  state.updateState((prev) => ({
    ...prev,
    facilities: [...prev.facilities, facility],
    deployments: [deployment, ...prev.deployments]
  }))
}

const tempDirs: string[] = []
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// Real git subprocesses: generous timeout for a loaded parallel run.
describe('IPC.DIFF_PATCH_EXPORT', { timeout: 20_000 }, () => {
  beforeEach(() => {
    handlers.clear()
    vi.clearAllMocks()
  })

  it('rejects a malformed request, an unknown mission, and a mission without changes', async () => {
    const { state, call } = setup()
    expect(await call({ deploymentId: 'deploy-1', target: 'printer' })).toEqual({
      ok: false,
      error: 'Invalid patch export request'
    })
    expect(await call({ deploymentId: 'nope', target: 'clipboard' })).toEqual({
      ok: false,
      error: 'Deployment not found: nope'
    })
    state.updateState((prev) => ({
      ...prev,
      deployments: [
        {
          id: 'empty',
          companionId: prev.companions[0].id,
          facilityId: 'f',
          taskPrompt: 't',
          status: 'completed',
          startedAt: 0,
          diffFiles: []
        },
        ...prev.deployments
      ]
    }))
    expect(await call({ deploymentId: 'empty', target: 'clipboard' })).toEqual({
      ok: false,
      error: 'This mission has no file changes to export'
    })
    expect(electron.clipboard.writeText).not.toHaveBeenCalled()
  })

  it('copies the whole mission as one patch that git apply accepts', async () => {
    const { repoPath, baselineSha } = await makeRepo()
    tempDirs.push(repoPath)
    const { state, call } = setup()
    seedMission(state, repoPath, baselineSha)
    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nupdated line\n')
    await writeFile(path.join(repoPath, 'notes.md'), '# Notes\n')

    const result = await call({ deploymentId: 'deploy-1', target: 'clipboard' })

    expect(result).toEqual({ ok: true, outcome: 'copied' })
    expect(electron.clipboard.writeText).toHaveBeenCalledTimes(1)
    const text = electron.clipboard.writeText.mock.calls[0][0] as string
    expect(text).toContain('Mech: Atlas-Prime')
    expect(text).toContain('Project: Reactor Control')
    expect(text).toContain(`Baseline: ${baselineSha}`)
    expect(text).toContain('diff --git a/tracked.txt b/tracked.txt')
    expect(text).toContain('--- /dev/null\n+++ b/notes.md')

    // Prove it is a usable patch: reset the repo, apply it, get the edits back.
    await runGit(repoPath, ['checkout', '--', 'tracked.txt'])
    await rm(path.join(repoPath, 'notes.md'))
    const patchFile = path.join(repoPath, '..', `${path.basename(repoPath)}.patch`)
    tempDirs.push(patchFile)
    await writeFile(patchFile, text)
    await runGit(repoPath, ['apply', patchFile])
    // git apply writes through the working-tree conversion, so a runner with
    // core.autocrlf on (the Windows CI image) hands back CRLF. Compare content.
    const applied = async (name: string): Promise<string> =>
      (await readFile(path.join(repoPath, name), 'utf8')).replace(/\r\n/g, '\n')
    expect(await applied('tracked.txt')).toBe('line one\nupdated line\n')
    expect(await applied('notes.md')).toBe('# Notes\n')
  })

  it('saves through the OS dialog with a mission-named default, and reports a cancel', async () => {
    const { repoPath, baselineSha } = await makeRepo()
    tempDirs.push(repoPath)
    const { state, call } = setup()
    seedMission(state, repoPath, baselineSha)
    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nupdated line\n')
    await writeFile(path.join(repoPath, 'notes.md'), '# Notes\n')
    const target = path.join(repoPath, 'exported.patch')

    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: true, filePath: '' })
    expect(await call({ deploymentId: 'deploy-1', target: 'file' })).toEqual({
      ok: true,
      outcome: 'cancelled'
    })

    electron.dialog.showSaveDialog.mockResolvedValueOnce({ canceled: false, filePath: target })
    expect(await call({ deploymentId: 'deploy-1', target: 'file' })).toEqual({
      ok: true,
      outcome: 'saved',
      path: target
    })
    const options = electron.dialog.showSaveDialog.mock.calls[0][1] as { defaultPath: string }
    expect(path.basename(options.defaultPath)).toMatch(
      /^mechbay-atlas-prime-reactor-control-\d{8}-\d{4}\.patch$/
    )
    expect(await readFile(target, 'utf8')).toContain('diff --git a/notes.md b/notes.md')
  })

  it('refuses a path outside the project even when it is listed in diffFiles', async () => {
    const { repoPath, baselineSha } = await makeRepo()
    tempDirs.push(repoPath)
    const { state, call } = setup()
    seedMission(state, repoPath, baselineSha)
    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) =>
        d.id === 'deploy-1'
          ? { ...d, diffFiles: [{ path: '../outside.txt', insertions: 1, deletions: 0 }] }
          : d
      )
    }))

    expect(await call({ deploymentId: 'deploy-1', target: 'clipboard' })).toEqual({
      ok: false,
      error: 'None of the changed files could be read'
    })
    expect(electron.clipboard.writeText).not.toHaveBeenCalled()
  })
})
