import { tmpdir } from 'os'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager } from '../../src/main/state-manager'
import { MissionRegistry, shutdownMissions } from '../../src/main/mission-registry'
import { killProcessTree } from '../../src/main/runners/process-tree'
import type { Runner } from '../../src/main/runners/types'
import type { Deployment, LogChunk } from '../../src/shared/types'
import {
  controllableRunner,
  type ControlledRun,
  fakeFsReader,
  makeFakeWin,
  makeInMemoryStore,
  runnersFor
} from '../helpers/ipc-harness'
import { FakeAgentRunner, waitUntilDead } from '../helpers/fake-agent-runner'
import { makeLogSink } from '../helpers/log-sink'

const handlers = vi.hoisted(
  () => new Map<string, (event: unknown, ...args: unknown[]) => unknown>()
)
const baseline = vi.hoisted(() => ({ gate: null as Promise<void> | null }))

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
  captureGitBaseline: vi.fn(async () => {
    if (baseline.gate) await baseline.gate
    return null
  }),
  computeDiffSummary: vi.fn(async () => null),
  isGitRepository: vi.fn(async () => 'none'),
  readFilePatch: vi.fn(),
  resolveInRepo: vi.fn()
}))
vi.mock('../../src/main/soul-memory', () => ({
  assembleSystemPrompt: (_n: string, _p: unknown, task: string) => task,
  appendMemoryEntry: vi.fn(),
  readSoul: vi.fn(),
  writeSoul: vi.fn(),
  readMemory: vi.fn()
}))

import { registerIpc } from '../../src/main/ipc'

// Everything a test started, so afterEach can stop it even when the test
// fails: a test only ever stops its own agents, through their own handles.
const started: { missions: MissionRegistry[]; runs: ControlledRun[][] } = {
  missions: [],
  runs: []
}

interface Harness {
  state: StateManager
  missions: MissionRegistry
  entries: LogChunk[]
  deploy: (mech: number, task?: string) => Promise<{ deploymentId: string }>
  abort: (id: string) => unknown
  mission: (id: string) => Deployment | undefined
}

function setup(runner: Runner, cap = 3): Harness {
  handlers.clear()
  const state = new StateManager(makeInMemoryStore(), '/tmp/mechbay-recall-test')
  state.updateState((s) => ({
    ...s,
    settings: { ...s.settings, concurrencyCap: cap },
    facilities: s.facilities.map((f) => ({ ...f, path: tmpdir() }))
  }))
  const missions = new MissionRegistry()
  started.missions.push(missions)
  const { sink, entries } = makeLogSink()
  registerIpc({
    win: makeFakeWin(),
    state,
    runners: runnersFor(runner),
    fsReader: fakeFsReader,
    secrets: { envFor: () => ({}), getSecret: () => null } as never,
    logs: sink,
    missions
  })
  const s = state.getState()
  const deploy: Harness['deploy'] = (mech, task = `task ${mech}`) =>
    handlers.get(IPC.DEPLOY_START)!(
      {},
      { companionId: s.companions[mech].id, facilityId: s.facilities[mech].id, taskPrompt: task }
    ) as Promise<{ deploymentId: string }>
  const abort: Harness['abort'] = (id) => handlers.get(IPC.DEPLOY_ABORT)!({}, id)
  const mission: Harness['mission'] = (id) => state.getState().deployments.find((d) => d.id === id)
  return { state, missions, entries, deploy, abort, mission }
}

function controlled(
  options?: Parameters<typeof controllableRunner>[0]
): ReturnType<typeof controllableRunner> {
  const made = controllableRunner(options)
  started.runs.push(made.runs)
  return made
}

afterEach(async () => {
  for (const run of started.runs.splice(0).flat()) run.finish(-1)
  await Promise.all(started.missions.splice(0).map((m) => m.abortAll(10_000)))
})

describe('recall', () => {
  beforeEach(() => {
    baseline.gate = null
  })

  it('recalling a real agent ends both processes and the mission stays cancelled after its late exit', async () => {
    const runner = new FakeAgentRunner({
      killTree: (child) => killProcessTree(child, { graceMs: 500 })
    })
    const { missions, entries, deploy, abort, mission } = setup(runner)
    const { deploymentId } = await deploy(0)

    let pids: number[] = []
    await vi.waitFor(
      () => {
        const text = entries.map((e) => e.text).join('\n')
        const parent = /PARENT_PID=(\d+)/.exec(text)
        const child = /CHILD_PID=(\d+)/.exec(text)
        expect(parent && child).toBeTruthy()
        pids = [Number(parent![1]), Number(child![1])]
      },
      { timeout: 10_000 }
    )

    await expect(abort(deploymentId)).resolves.toEqual({ ok: true })
    expect(await waitUntilDead(pids, 5000)).toEqual([])
    await vi.waitFor(() => expect(missions.ids()).toEqual([]), { timeout: 5000 })
    expect(mission(deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Recalled by the commander.'
    })
  }, 30_000)

  it('advances the queue after a recall', async () => {
    const { runner, runs } = controlled()
    const { deploy, abort } = setup(runner, 1)
    const first = await deploy(0, 'first')
    await deploy(1, 'second')
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await abort(first.deploymentId)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['first', 'second']))
    expect(runs[0].aborted).toBe(true)
  })

  it('the queue moves on even when a recalled agent does not exit', async () => {
    const { runner, runs } = controlled({ ignoreAbort: true })
    const { deploy, abort } = setup(runner, 1)
    const first = await deploy(0, 'first')
    await deploy(1, 'second')
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await abort(first.deploymentId)
    await vi.waitFor(() => expect(runs.map((r) => r.prompt)).toEqual(['first', 'second']))
  })

  it('a late exit with code 0 cannot turn a recall into a success', async () => {
    const { runner, runs } = controlled({ ignoreAbort: true })
    const { missions, deploy, abort, mission } = setup(runner)
    const { deploymentId } = await deploy(0)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    await abort(deploymentId)
    expect(runs[0].aborted).toBe(true)
    runs[0].finish(0)
    await vi.waitFor(() => expect(missions.ids()).toEqual([]))
    await new Promise((r) => setTimeout(r, 50))
    expect(mission(deploymentId)?.exitCode).toBeUndefined()
    expect(mission(deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Recalled by the commander.'
    })
  })

  it('a recall before the agent starts means it never starts', async () => {
    let open!: () => void
    baseline.gate = new Promise<void>((r) => (open = r))
    const { runner, runs } = controlled()
    const { missions, deploy, abort, mission } = setup(runner)
    const { deploymentId } = await deploy(0)
    await expect(abort(deploymentId)).resolves.toEqual({ ok: true })
    open()
    await vi.waitFor(() => expect(missions.ids()).toEqual([]))
    await new Promise((r) => setTimeout(r, 50))
    expect(runs).toHaveLength(0)
    expect(mission(deploymentId)?.status).toBe('cancelled')
  })

  it('a recall while the agent is starting stops it as soon as it exists', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { runner, runs } = controlled()
    const slowRunner: Runner = {
      isAvailable: runner.isAvailable,
      spawn: async (...args) => (await gate, runner.spawn(...args))
    }
    const { deploy, abort, mission } = setup(slowRunner)
    const { deploymentId } = await deploy(0)
    await vi.waitFor(() => expect(mission(deploymentId)?.status).toBe('working'))
    await abort(deploymentId)
    release()
    await vi.waitFor(() => expect(runs[0]?.aborted).toBe(true))
    expect(mission(deploymentId)?.status).toBe('cancelled')
  })
})

/** A runner whose abort records the call and then fails, as a broken kill would. */
function failingAbortRunner(): { runner: Runner; aborts: string[]; finishAll: () => void } {
  const aborts: string[] = []
  const finishers: Array<() => void> = []
  const runner: Runner = {
    isAvailable: async () => true,
    spawn: async (_cwd, prompt) => {
      let finish!: (code: number) => void
      const exit = new Promise<number>((resolve) => (finish = resolve))
      finishers.push(() => finish(-1))
      async function* stream(): AsyncGenerator<never> {
        await exit
        yield* []
      }
      return {
        stream: stream(),
        exit,
        abort: async () => {
          aborts.push(prompt)
          throw new Error('taskkill could not start')
        }
      }
    }
  }
  return { runner, aborts, finishAll: () => finishers.forEach((f) => f()) }
}

describe('recall when stopping the agent fails', () => {
  beforeEach(() => {
    baseline.gate = null
  })

  it('still reports the recall and keeps the mission cancelled', async () => {
    const { runner, aborts, finishAll } = failingAbortRunner()
    const { missions, deploy, abort, mission } = setup(runner)
    const { deploymentId } = await deploy(0, 'stubborn')
    await vi.waitFor(() => expect(missions.ids()).toEqual([deploymentId]))
    await expect(abort(deploymentId)).resolves.toEqual({ ok: true })
    expect(aborts).toEqual(['stubborn'])
    finishAll()
    await vi.waitFor(() => expect(missions.ids()).toEqual([]))
    expect(mission(deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Recalled by the commander.'
    })
  })

  it('a failed stop of an agent recalled while starting is logged, not thrown', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    const { runner, aborts, finishAll } = failingAbortRunner()
    const slowRunner: Runner = {
      isAvailable: runner.isAvailable,
      spawn: async (...args) => (await gate, runner.spawn(...args))
    }
    const { missions, deploy, abort, mission } = setup(slowRunner)
    const { deploymentId } = await deploy(0, 'starting')
    await vi.waitFor(() => expect(mission(deploymentId)?.status).toBe('working'))
    await abort(deploymentId)
    release()
    await vi.waitFor(() => expect(aborts).toEqual(['starting']))
    finishAll()
    await vi.waitFor(() => expect(missions.ids()).toEqual([]))
    expect(mission(deploymentId)?.status).toBe('cancelled')
  })
})

describe('agent output failures', () => {
  it('stops the agent when reading its output fails, and the mission fails', async () => {
    let aborted = false
    const runner: Runner = {
      isAvailable: async () => true,
      spawn: async () => {
        // The agent keeps running; only its output stream breaks.
        const exit = new Promise<number>(() => {})
        async function* stream(): AsyncGenerator<{ stream: 'stdout'; text: string }> {
          yield { stream: 'stdout', text: 'working\n' }
          throw new Error('output pipe broke')
        }
        return {
          stream: stream(),
          exit,
          abort: async () => {
            aborted = true
          }
        }
      }
    }
    const { missions, deploy, mission } = setup(runner)
    const { deploymentId } = await deploy(0)
    await vi.waitFor(() => expect(mission(deploymentId)?.status).toBe('failed'))
    expect(aborted).toBe(true)
    expect(mission(deploymentId)?.summary).toBe('output pipe broke')
    await vi.waitFor(() => expect(missions.ids()).toEqual([]))
  })
})

describe('shutdownMissions', () => {
  it('recalls running missions, cancels queued ones, and flushes logs', async () => {
    const { runner, runs } = controlled()
    const { state, missions, deploy, mission } = setup(runner, 1)
    const running = await deploy(0)
    const waiting = await deploy(1)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const flushAll = vi.fn()
    await shutdownMissions({ state, missions, logs: { flushAll }, timeoutMs: 2000 })
    expect(mission(running.deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Recalled when MechBay closed.'
    })
    expect(mission(waiting.deploymentId)).toMatchObject({
      status: 'cancelled',
      summary: 'Cancelled: MechBay closed before it started.'
    })
    expect(runs[0].aborted).toBe(true)
    expect(flushAll).toHaveBeenCalled()
    // The aborted mission's exit reruns the scheduler; nothing is left to start.
    await new Promise((r) => setTimeout(r, 50))
    expect(runs).toHaveLength(1)
  })

  it('gives up waiting on an agent that will not stop', async () => {
    const { runner, runs } = controlled({ ignoreAbort: true })
    const { state, missions, deploy } = setup(runner)
    await deploy(0)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    const abortAll = vi.spyOn(missions, 'abortAll')
    const flushAll = vi.fn()
    const begun = Date.now()
    // The controllable runner's abort resolves at once, so model a hung stop.
    missions.set('hung', { abort: () => new Promise<void>(() => {}) })
    await shutdownMissions({ state, missions, logs: { flushAll }, timeoutMs: 200 })
    expect(Date.now() - begun).toBeLessThan(2000)
    expect(abortAll).toHaveBeenCalledWith(200)
    expect(flushAll).toHaveBeenCalled()
    missions.delete('hung')
  })
})
