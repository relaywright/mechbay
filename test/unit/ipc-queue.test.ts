import { beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager } from '../../src/main/state-manager'
import type { AgentFamily, Deployment } from '../../src/shared/types'
import {
  controllableRunner,
  type ControlledRun,
  fakeFsReader,
  makeFakeWin,
  makeInMemoryStore,
  runnersFor
} from '../helpers/ipc-harness'
import { makeLogSink } from '../helpers/log-sink'

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
)

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, fn: (event: unknown, ...args: unknown[]) => unknown) =>
      handlers.set(channel, fn)
    )
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))
vi.mock('../../src/main/git-diff', () => ({
  captureGitBaseline: vi.fn(async () => null),
  computeDiffSummary: vi.fn(async () => null),
  isGitRepository: vi.fn(async () => 'none'),
  readFilePatch: vi.fn(),
  resolveInRepo: vi.fn()
}))
vi.mock('../../src/main/soul-memory', () => ({
  assembleSystemPrompt: (_name: string, _paths: unknown, task: string) => task,
  appendMemoryEntry: vi.fn(),
  readSoul: vi.fn(),
  writeSoul: vi.fn(),
  readMemory: vi.fn()
}))

import {
  queuedRawPromptIdsForTests,
  registerIpc,
  startQueuedMissions,
  type IpcDeps
} from '../../src/main/ipc'

interface Harness {
  state: StateManager
  runs: ControlledRun[]
  opts: IpcDeps
  deploy: (mech: number, task: string) => Promise<{ deploymentId: string; status: string }>
  abort: (id: string) => unknown
  status: (id: string) => Deployment | undefined
}

function setup(
  cap: number,
  runnerOptions?: Parameters<typeof controllableRunner>[0],
  storedKey?: string
): Harness {
  handlers.clear()
  let clock = 1_000
  vi.spyOn(Date, 'now').mockImplementation(() => clock++)
  const state = new StateManager(makeInMemoryStore(), '/tmp/mechbay-queue-test')
  state.updateState((s) => ({
    ...s,
    settings: { ...s.settings, concurrencyCap: cap },
    facilities: s.facilities.map((f, i) => ({ ...f, path: `/tmp/project-${i}` }))
  }))
  const { runner, runs } = controllableRunner(runnerOptions)
  const opts: IpcDeps = {
    win: makeFakeWin(),
    state,
    runners: runnersFor(runner),
    fsReader: fakeFsReader,
    secrets: {
      envFor: () => ({}),
      getSecret: (runtime: AgentFamily) => (runtime === 'claude' ? (storedKey ?? null) : null)
    } as never,
    logs: makeLogSink().sink
  }
  registerIpc(opts)
  const s = state.getState()
  const deploy: Harness['deploy'] = (mech, task) =>
    handlers.get(IPC.DEPLOY_START)!(
      {},
      { companionId: s.companions[mech].id, facilityId: s.facilities[mech].id, taskPrompt: task }
    ) as Promise<{ deploymentId: string; status: string }>
  const abort: Harness['abort'] = (id) => handlers.get(IPC.DEPLOY_ABORT)!({}, id)
  const status: Harness['status'] = (id) => state.getState().deployments.find((x) => x.id === id)
  return { state, runs, opts, deploy, abort, status }
}

describe('mission queue scheduling', () => {
  beforeEach(() => vi.restoreAllMocks())

  it('starts queued missions oldest first', async () => {
    const { runs, deploy } = setup(1)
    await deploy(0, 'first')
    await deploy(1, 'second')
    await deploy(2, 'third')
    expect(runs.map((r) => r.prompt)).toEqual(['first'])
    runs[0].finish(0)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['first', 'second']))
    runs[1].finish(0)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['first', 'second', 'third']))
  })

  it('fills every free slot, not just one', async () => {
    const { state, runs, opts } = setup(2)
    const s = state.getState()
    const queued: Deployment[] = [0, 1, 2].map((i) => ({
      id: `Q${i}0000000000000000000000`,
      companionId: s.companions[i].id,
      facilityId: s.facilities[i].id,
      taskPrompt: `task ${i}`,
      status: 'queued',
      startedAt: 10 + i
    }))
    state.updateState((prev) => ({ ...prev, deployments: queued }))
    startQueuedMissions(opts)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(state.getState().deployments.find((d) => d.id === queued[2].id)?.status).toBe('queued')
  })

  it('keeps going after a mission fails to launch', async () => {
    const { runs, deploy, status } = setup(1, { failSpawn: (prompt) => prompt === 'broken' })
    const broken = await deploy(0, 'broken')
    await deploy(1, 'next')
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['next']))
    expect(status(broken.deploymentId)?.status).toBe('failed')
  })

  it('keeps going after a mission has no runner', async () => {
    const { state, runs, deploy, status } = setup(1)
    state.updateState((s) => ({
      ...s,
      companions: s.companions.map((c, i) =>
        i === 0 ? { ...c, runtime: 'nonexistent' as never } : c
      )
    }))
    const orphan = await deploy(0, 'no runner')
    await deploy(1, 'next')
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['next']))
    expect(status(orphan.deploymentId)?.summary).toMatch(/No runner/)
  })

  it('keeps going after a mission exits with an error', async () => {
    const { runs, deploy, status } = setup(1)
    const first = await deploy(0, 'first')
    await deploy(1, 'second')
    runs[0].finish(1)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['first', 'second']))
    expect(status(first.deploymentId)?.status).toBe('failed')
  })

  it('fails a queued mission whose building was removed, then starts the next', async () => {
    const { state, runs, deploy, status } = setup(1)
    await deploy(0, 'running')
    const stranded = await deploy(1, 'stranded')
    await deploy(2, 'next')
    const removed = status(stranded.deploymentId)!.facilityId
    state.updateState((s) => ({ ...s, facilities: s.facilities.filter((f) => f.id !== removed) }))
    runs[0].finish(0)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['running', 'next']))
    expect(status(stranded.deploymentId)).toMatchObject({
      status: 'failed',
      summary: 'This building was removed before the mission started.'
    })
    expect(queuedRawPromptIdsForTests()).not.toContain(stranded.deploymentId)
  })

  it('refuses a second mission for a mech that already has one', async () => {
    const { deploy } = setup(3)
    await deploy(0, 'first')
    await expect(deploy(0, 'again')).rejects.toThrow(
      'is already on a mission. Wait for it to return, or recall it first.'
    )
  })

  it('runs a queued mission with the exact prompt typed and the mech level at launch', async () => {
    const key = 'sk-queue-test-secret-123456'
    const { state, runs, deploy, status } = setup(1, undefined, key)
    await deploy(0, 'running')
    const waiting = await deploy(1, `use ${key} please`)
    // Saved state only ever holds the redacted copy.
    expect(status(waiting.deploymentId)?.taskPrompt).toBe('use [redacted] please')
    const mech = status(waiting.deploymentId)!.companionId
    state.updateState((s) => ({
      ...s,
      companions: s.companions.map((c) =>
        c.id === mech ? { ...c, runtime: 'claude', autonomy: 'read' } : c
      )
    }))
    runs[0].finish(0)
    await vi.waitFor(() => expect(runs).toHaveLength(2))
    expect(runs[1].prompt).toBe(`use ${key} please`)
    expect(runs[1].options?.autonomy).toBe('read')
    expect(status(waiting.deploymentId)?.autonomy).toBe('read')
    expect(queuedRawPromptIdsForTests()).not.toContain(waiting.deploymentId)
  })

  it('cancels a queued mission without ever starting it', async () => {
    const { runs, deploy, abort, status } = setup(1)
    await deploy(0, 'running')
    const waiting = await deploy(1, 'waiting')
    expect(queuedRawPromptIdsForTests()).toContain(waiting.deploymentId)
    await expect(abort(waiting.deploymentId)).resolves.toEqual({ ok: true })
    expect(status(waiting.deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled before it started.'
    })
    // The raw prompt of a mission that will never run is forgotten at once.
    expect(queuedRawPromptIdsForTests()).not.toContain(waiting.deploymentId)
    runs[0].finish(0)
    await vi.waitFor(() => expect(status(waiting.deploymentId)?.status).toBe('cancelled'))
    expect(runs).toHaveLength(1)
  })

  it('forgets the raw prompt of a queued mission the boot sweep cancelled', async () => {
    const { state, opts, deploy, status } = setup(1)
    await deploy(0, 'running')
    const waiting = await deploy(1, 'waiting')
    state.sweepZombieDeployments()
    expect(status(waiting.deploymentId)?.status).toBe('cancelled')
    startQueuedMissions(opts)
    expect(queuedRawPromptIdsForTests()).not.toContain(waiting.deploymentId)
  })

  it('says so when asked to cancel a mission that already ended', async () => {
    const { runs, deploy, abort } = setup(1)
    const done = await deploy(0, 'quick')
    runs[0].finish(0)
    await vi.waitFor(async () =>
      expect(await abort(done.deploymentId)).toEqual({
        ok: false,
        error: 'This mission has already ended.'
      })
    )
    expect(await abort('missing')).toEqual({ ok: false, error: 'Mission not found.' })
  })

  it('does not yet recall a running mission', async () => {
    const { deploy, abort } = setup(1)
    const running = await deploy(0, 'running')
    await expect(abort(running.deploymentId)).rejects.toThrow(
      'Recalling a running mission arrives in this release.'
    )
  })
})
