import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner, RunnerChunk, SpawnResult } from '../../src/main/runners/types'
import type { AgentFamily, Companion, Deployment, Facility, LogChunk } from '../../src/shared/types'
import { LogStore } from '../../src/main/log-store'
import { makeLogSink } from '../helpers/log-sink'
import { MissionRegistry } from '../../src/main/mission-registry'

/**
 * An agent that echoes its environment (or an error that quotes a key)
 * must never put an API key into the live log, the saved log, the mission
 * summary, or the mech's memory. Text is redacted before it reaches the
 * log store, so the window and the log file on disk both get the clean copy. Keys come from Settings (SecretsManager)
 * and from the environment variables the runners read.
 */

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  app: { getPath: vi.fn() },
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      registeredHandlers.set(channel, handler)
    })
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

import {
  executeDeployment,
  LAUNCHED_LINE,
  registerIpc,
  startQueuedMissions
} from '../../src/main/ipc'

const STORED_KEY = 'fw-stored-secret-1234567890'
const ENV_KEY = 'sk-env-secret-0987654321'

const tempDirs: string[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
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

function runnerWith(spawn: Runner['spawn']): Record<AgentFamily, Runner> {
  const runner: Runner = { isAvailable: async () => true, spawn }
  return { claude: runner, codex: runner, kimi: runner, gemini: runner, hermes: runner }
}

function streamOf(chunks: RunnerChunk[]): SpawnResult {
  return {
    stream: (async function* () {
      yield* chunks
    })(),
    abort: async () => {},
    exit: Promise.resolve(0)
  }
}

async function setup(): Promise<{
  state: StateManager
  send: ReturnType<typeof vi.fn>
  companion: Companion
  facility: Facility
  deployment: Deployment
  dir: string
}> {
  const dir = await mkdtemp(path.join(tmpdir(), 'mechbay-log-redaction-'))
  tempDirs.push(dir)
  const soulPath = path.join(dir, 'soul.md')
  const memoryPath = path.join(dir, 'memory.md')
  await writeFile(soulPath, '# Soul\n')
  await writeFile(memoryPath, '# Memory\n')

  const state = new StateManager(makeInMemoryStore(), dir)
  const companion: Companion = {
    ...state.getState().companions[0],
    family: 'kimi',
    runtime: undefined,
    soulPath,
    memoryPath
  }
  const facility: Facility = {
    id: 'facility-redaction',
    name: 'redaction-facility',
    path: dir,
    facilityType: 'research-lab',
    tile: { x: 8, y: 3 },
    source: 'manual',
    discoveredAt: Date.now()
  }
  const deployment: Deployment = {
    id: 'deployment-redaction',
    companionId: companion.id,
    facilityId: facility.id,
    taskPrompt: 'Print the environment',
    status: 'walking-to',
    startedAt: Date.now()
  }
  state.updateState((prev) => ({ ...prev, deployments: [deployment, ...prev.deployments] }))
  return { state, send: vi.fn(), companion, facility, deployment, dir }
}

/**
 * The production log path: a real LogStore that sends each flushed batch to
 * the window (as index.ts wires it) and writes it under `dir`/logs.
 */
function diskLogs(
  dir: string,
  send: ReturnType<typeof vi.fn>
): { logs: LogStore; sentTexts: () => string[]; savedTexts: () => Promise<string[]> } {
  const logDir = path.join(dir, 'logs')
  const toWindow = send as unknown as (channel: string, entries: LogChunk[]) => void
  return {
    logs: new LogStore({ dir: logDir, onEntries: (entries) => toWindow(IPC.LOG_STREAM, entries) }),
    sentTexts: () =>
      send.mock.calls.flatMap(([, entries]) => (entries as LogChunk[]).map((e) => e.text)),
    savedTexts: async () => {
      const texts: string[] = []
      for (const name of await readdir(logDir)) {
        const lines = (await readFile(path.join(logDir, name), 'utf8')).split('\n')
        for (const line of lines.filter(Boolean)) texts.push((JSON.parse(line) as LogChunk).text)
      }
      return texts
    }
  }
}

function secretsStub(): never {
  return {
    envFor: vi.fn(() => ({ FIREWORKS_API_KEY: STORED_KEY })),
    getSecret: vi.fn((runtime: AgentFamily) => (runtime === 'kimi' ? STORED_KEY : null))
  } as never
}

describe('deployment logs never contain API keys', () => {
  it('redacts stored and environment keys from streamed and saved log chunks', async () => {
    vi.stubEnv('OPENAI_API_KEY', ENV_KEY)
    const { state, send, companion, facility, deployment, dir } = await setup()
    const runners = runnerWith(async () =>
      streamOf([
        { stream: 'stdout', text: `FIREWORKS_API_KEY=${STORED_KEY}\n` },
        { stream: 'stderr', text: `OPENAI_API_KEY=${ENV_KEY}\n` }
      ])
    )
    const { logs, sentTexts, savedTexts } = diskLogs(dir, send)

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    const sent = sentTexts().join('\n')
    const saved = (await savedTexts()).join('\n')
    for (const text of [sent, saved]) {
      expect(text).toContain('FIREWORKS_API_KEY=[redacted]')
      expect(text).toContain('OPENAI_API_KEY=[redacted]')
      expect(text).not.toContain(STORED_KEY)
      expect(text).not.toContain(ENV_KEY)
    }
  })

  it('redacts a key quoted in a failure message from the summary and memory', async () => {
    const { state, send, companion, facility, deployment } = await setup()
    const runners = runnerWith(async () => {
      throw new Error(`auth rejected for key ${STORED_KEY}`)
    })

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    const failed = state.getState().deployments.find((d) => d.id === deployment.id)
    expect(failed?.status).toBe('failed')
    expect(failed?.summary).toBe('auth rejected for key [redacted]')
    const memory = await readFile(companion.memoryPath, 'utf8')
    expect(memory).toContain('auth rejected for key [redacted]')
    expect(memory).not.toContain(STORED_KEY)
  })

  it('redacts the key the mission actually launched with, even if Settings changed', async () => {
    const NEW_KEY = 'fw-rotated-secret-5555555555'
    const launchEnv = { FIREWORKS_API_KEY: NEW_KEY, MY_SERVICE_TOKEN: 'tok-launch-only-77777777' }
    const envFor = vi.fn(() => launchEnv)
    const spawnedEnvs: unknown[] = []
    const { state, send, companion, facility, deployment } = await setup()
    const { sink, entries } = makeLogSink()
    const runners = runnerWith(async (_cwd, _prompt, spawnOpts) => {
      spawnedEnvs.push(spawnOpts?.env)
      return streamOf([
        { stream: 'stdout', text: `FIREWORKS_API_KEY=${NEW_KEY}\n` },
        { stream: 'stdout', text: `MY_SERVICE_TOKEN=${launchEnv.MY_SERVICE_TOKEN}\n` }
      ])
    })

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: {
        envFor,
        getSecret: vi.fn((runtime: AgentFamily) => (runtime === 'kimi' ? STORED_KEY : null))
      } as never
    })

    expect(envFor).toHaveBeenCalledTimes(1)
    expect(spawnedEnvs).toEqual([launchEnv])
    expect(spawnedEnvs[0]).toBe(launchEnv)
    const saved = entries.map((chunk) => chunk.text).join('\n')
    expect(saved).toContain('FIREWORKS_API_KEY=[redacted]')
    expect(saved).toContain('MY_SERVICE_TOKEN=[redacted]')
    expect(saved).not.toContain(NEW_KEY)
    expect(saved).not.toContain(launchEnv.MY_SERVICE_TOKEN)
  })

  it('redacts any inherited environment variable whose name says it is a secret', async () => {
    const GITHUB_TOKEN = 'ghp-inherited-token-1234567890'
    const DB_PASSWORD = 'db-inherited-password-0987'
    vi.stubEnv('GITHUB_TOKEN', GITHUB_TOKEN)
    vi.stubEnv('Db_Password', DB_PASSWORD)
    const { state, send, companion, facility, deployment } = await setup()
    const { sink, entries } = makeLogSink()
    const runners = runnerWith(async () =>
      streamOf([{ stream: 'stdout', text: `GITHUB_TOKEN=${GITHUB_TOKEN} pw=${DB_PASSWORD}\n` }])
    )

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    const saved = entries.map((chunk) => chunk.text).join('\n')
    expect(saved).toContain('GITHUB_TOKEN=[redacted] pw=[redacted]')
    expect(saved).not.toContain(GITHUB_TOKEN)
    expect(saved).not.toContain(DB_PASSWORD)
  })

  it('hides every line of a multi-line secret that a tool prints line by line', async () => {
    const pemLines = [
      '-----BEGIN TEST PRIVATE KEY-----',
      'MIIBVQIBADANBgkqhkiG9w0BAQEFAASCAT8wggE7',
      'AgEAAkEAq7BFUpkGp3+XQZ4x0VnMV1tYdT0d2Nbn',
      '-----END TEST PRIVATE KEY-----'
    ]
    vi.stubEnv('SERVICE_PRIVATE_KEY', pemLines.join('\n'))
    const { state, send, companion, facility, deployment, dir } = await setup()
    const { logs, sentTexts, savedTexts } = diskLogs(dir, send)
    // `cat key.pem` output, split across chunks the way a pipe delivers it.
    const runners = runnerWith(async () =>
      streamOf([
        { stream: 'stdout', text: `${pemLines[0]}\n${pemLines[1]}\n` },
        { stream: 'stdout', text: `${pemLines[2]}\n` },
        { stream: 'stderr', text: `${pemLines[3]}\n` }
      ])
    )

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    const sent = sentTexts()
    const saved = await savedTexts()
    expect(sent.length).toBeGreaterThanOrEqual(pemLines.length)
    expect(saved.length).toBeGreaterThanOrEqual(pemLines.length)
    for (const text of [...sent, ...saved]) {
      for (const line of pemLines) expect(text).not.toContain(line)
    }
  })
})

describe('task text is redacted where it is stored, never where it runs', () => {
  it('redacts a key in the task from the memory entry', async () => {
    const { state, send, companion, facility, deployment } = await setup()

    await executeDeployment(deployment.id, companion, facility, `Deploy with ${STORED_KEY}`, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners: runnerWith(async () => streamOf([])),
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    const memory = await readFile(companion.memoryPath, 'utf8')
    expect(memory).toContain('Deploy with [redacted]')
    expect(memory).not.toContain(STORED_KEY)
  })

  it('stores a redacted task for display and runs the raw one, for both started and queued missions', async () => {
    registeredHandlers.clear()
    const { state, send, companion, facility } = await setup()
    // A mech holds one open mission at a time, so a second mech queues.
    const mate = { ...companion, id: 'companion-queue-mate', name: 'Queue-Mate' }
    state.updateState((prev) => ({
      ...prev,
      companions: [...prev.companions.map((c) => (c.id === companion.id ? companion : c)), mate],
      facilities: [...prev.facilities, facility],
      deployments: [],
      settings: { ...prev.settings, concurrencyCap: 1 }
    }))
    let finishFirst: (code: number) => void = () => {}
    const spawnedPrompts: string[] = []
    const { sink, entries } = makeLogSink()
    registerIpc({
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners: runnerWith(async (_cwd, prompt) => {
        spawnedPrompts.push(prompt)
        if (spawnedPrompts.length > 1) return streamOf([])
        return { ...streamOf([]), exit: new Promise<number>((resolve) => (finishFirst = resolve)) }
      }),
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })
    const deployStart = registeredHandlers.get(IPC.DEPLOY_START)
    if (!deployStart) throw new Error('DEPLOY_START handler was not registered')
    const start = async (
      taskPrompt: string,
      companionId = companion.id
    ): Promise<{ deploymentId: string; status: string }> =>
      (await deployStart({}, { companionId, facilityId: facility.id, taskPrompt })) as {
        deploymentId: string
        status: string
      }

    const first = await start(`First run uses ${STORED_KEY}`)
    // Real git runs for the baseline first, which is slow under a busy suite.
    await vi.waitFor(() => expect(spawnedPrompts).toHaveLength(1), { timeout: 15_000 })
    const second = await start(`Queued run uses ${STORED_KEY}`, mate.id)
    expect(second.status).toBe('queued')

    const stored = (id: string): string | undefined =>
      state.getState().deployments.find((d) => d.id === id)?.taskPrompt
    expect(stored(first.deploymentId)).toBe('First run uses [redacted]')
    expect(stored(second.deploymentId)).toBe('Queued run uses [redacted]')
    expect(spawnedPrompts[0]).toContain(`First run uses ${STORED_KEY}`)

    finishFirst(0)
    await vi.waitFor(() => expect(spawnedPrompts).toHaveLength(2), { timeout: 15_000 })
    expect(spawnedPrompts[1]).toContain(`Queued run uses ${STORED_KEY}`)
    // Let the queued run finish writing memory before the temp folder goes.
    await vi.waitFor(
      () =>
        expect(state.getState().deployments.find((d) => d.id === second.deploymentId)?.status).toBe(
          'completed'
        ),
      { timeout: 15_000 }
    )
    expect(JSON.stringify(state.getState())).not.toContain(STORED_KEY)
    expect(JSON.stringify(entries)).not.toContain(STORED_KEY)
  }, 40_000)

  it('still redacts the key a queued task quoted after that key is replaced in Settings', async () => {
    const REPLACED_KEY = 'fw-replacement-secret-2468024680'
    registeredHandlers.clear()
    const { state, send, companion, facility } = await setup()
    // A second mech (same memory file) queues behind the first.
    const mate = { ...companion, id: 'companion-queue-mate', name: 'Queue-Mate' }
    state.updateState((prev) => ({
      ...prev,
      companions: [...prev.companions.map((c) => (c.id === companion.id ? companion : c)), mate],
      facilities: [...prev.facilities, facility],
      deployments: [],
      settings: { ...prev.settings, concurrencyCap: 1 }
    }))
    let storedKey = STORED_KEY
    let finishFirst: (code: number) => void = () => {}
    let spawns = 0
    const { sink, entries } = makeLogSink()
    registerIpc({
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      // The queued run echoes its whole prompt into the log, then crashes
      // with an error that quotes the task.
      runners: runnerWith(async (_cwd, prompt) => {
        spawns += 1
        if (spawns === 1) {
          return {
            ...streamOf([]),
            exit: new Promise<number>((resolve) => (finishFirst = resolve))
          }
        }
        const exit = Promise.reject(new Error(`crashed on: ${prompt.trim().split('\n').pop()}`))
        exit.catch(() => undefined) // executeDeployment awaits it after the stream drains
        return { ...streamOf([{ stream: 'stdout', text: prompt }]), exit }
      }),
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: {
        envFor: vi.fn(() => ({ FIREWORKS_API_KEY: storedKey })),
        getSecret: vi.fn((runtime: AgentFamily) => (runtime === 'kimi' ? storedKey : null))
      } as never
    })
    const deployStart = registeredHandlers.get(IPC.DEPLOY_START)
    if (!deployStart) throw new Error('DEPLOY_START handler was not registered')
    const start = async (
      taskPrompt: string,
      companionId = companion.id
    ): Promise<{ deploymentId: string; status: string }> =>
      (await deployStart({}, { companionId, facilityId: facility.id, taskPrompt })) as {
        deploymentId: string
        status: string
      }

    await start('Hold the slot')
    await vi.waitFor(() => expect(spawns).toBe(1), { timeout: 15_000 })
    const queued = await start(`Rotate away from ${STORED_KEY}`, mate.id)
    expect(queued.status).toBe('queued')

    // Sam replaces the stored key before the queued mission starts.
    storedKey = REPLACED_KEY
    finishFirst(0)

    await vi.waitFor(
      () => {
        const done = state.getState().deployments.find((d) => d.id === queued.deploymentId)
        expect(done?.status).toBe('failed')
      },
      { timeout: 15_000 }
    )
    const done = state.getState().deployments.find((d) => d.id === queued.deploymentId)
    const log = entries
      .filter((chunk) => chunk.deploymentId === queued.deploymentId)
      .map((chunk) => chunk.text)
      .join('\n')
    const memory = await readFile(companion.memoryPath, 'utf8')
    expect(log).toContain('Rotate away from [redacted]')
    expect(done?.summary).toBe('crashed on: Rotate away from [redacted]')
    expect(memory).toContain('Rotate away from [redacted]')
    for (const text of [log, done?.summary ?? '', memory, JSON.stringify(state.getState())]) {
      expect(text).not.toContain(STORED_KEY)
    }
  }, 40_000)
})

/**
 * Runners where looking up `crashing` throws, so executeDeployment rejects
 * outside its own try/catch and the caller's crash handler records the
 * failure. The error quotes a stored key.
 */
function runnersCrashingOn(crashing: AgentFamily): Record<AgentFamily, Runner> {
  const healthy: Runner = { isAvailable: async () => true, spawn: async () => streamOf([]) }
  const runners = {} as Record<AgentFamily, Runner>
  for (const family of ['claude', 'codex', 'kimi', 'gemini', 'hermes'] as AgentFamily[]) {
    if (family === crashing) {
      Object.defineProperty(runners, family, {
        enumerable: true,
        get: () => {
          throw new Error(`runner setup leaked ${STORED_KEY}`)
        }
      })
    } else {
      runners[family] = healthy
    }
  }
  return runners
}

describe('crash summaries never contain API keys', () => {
  it('redacts a stored key from a deployment that crashes after DEPLOY_START', async () => {
    registeredHandlers.clear()
    const { state, send, facility } = await setup()
    const seeded = state.getState().companions[0]
    // Clear setup's open mission: a mech holds one open mission at a time.
    state.updateState((prev) => ({
      ...prev,
      facilities: [...prev.facilities, facility],
      deployments: []
    }))
    registerIpc({
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners: runnersCrashingOn(seeded.runtime ?? seeded.family),
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })
    const deployStart = registeredHandlers.get(IPC.DEPLOY_START)
    if (!deployStart) throw new Error('DEPLOY_START handler was not registered')

    const { deploymentId } = (await deployStart(
      {},
      { companionId: seeded.id, facilityId: facility.id, taskPrompt: 'Crash please' }
    )) as { deploymentId: string }

    await vi.waitFor(() => {
      const crashed = state.getState().deployments.find((d) => d.id === deploymentId)
      expect(crashed?.status).toBe('failed')
      expect(crashed?.summary).toBe('runner setup leaked [redacted]')
    })
  })

  it('redacts a stored key from a queued deployment that crashes when it starts', async () => {
    const { state, send, companion, facility, deployment } = await setup()
    const queuedCompanion = state.getState().companions.find((c) => c.family !== 'kimi')
    if (!queuedCompanion) throw new Error('expected a seeded non-kimi companion')
    const queued: Deployment = {
      id: 'deployment-queued',
      companionId: queuedCompanion.id,
      facilityId: facility.id,
      taskPrompt: 'Wait your turn',
      status: 'queued',
      startedAt: Date.now()
    }
    state.updateState((prev) => ({
      ...prev,
      facilities: [...prev.facilities, facility],
      deployments: [...prev.deployments, queued]
    }))

    const opts = {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners: runnersCrashingOn(queuedCompanion.runtime ?? queuedCompanion.family),
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: {} as never,
      secrets: secretsStub()
    }
    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, opts)
    // In the app the scheduler runs after every mission ends; run it here.
    startQueuedMissions(opts)

    await vi.waitFor(() => {
      const crashed = state.getState().deployments.find((d) => d.id === queued.id)
      expect(crashed?.status).toBe('failed')
      expect(crashed?.summary).toBe('runner setup leaked [redacted]')
    })
  })
})

describe('the launch line', () => {
  it('is the first line of a mission, written before the agent says anything', async () => {
    const { state, send, companion, facility, deployment } = await setup()
    const { sink, entries } = makeLogSink()
    const runners = runnerWith(async () => streamOf([{ stream: 'stdout', text: 'hello\n' }]))

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    expect(entries[0]).toMatchObject({ stream: 'system', text: LAUNCHED_LINE })
    expect(entries.slice(1).some((e) => e.stream === 'stdout' && e.text.includes('hello'))).toBe(
      true
    )
  })

  it('is not written when the agent could not be launched', async () => {
    const { state, send, companion, facility, deployment } = await setup()
    const { sink, entries } = makeLogSink()
    const runners = runnerWith(async () => {
      throw new Error('spawn failed')
    })

    await executeDeployment(deployment.id, companion, facility, deployment.taskPrompt, {
      win: { isDestroyed: () => false, webContents: { send } } as unknown as BrowserWindow,
      state,
      runners,
      missions: new MissionRegistry(),
      logs: sink,
      fsReader: {} as never,
      secrets: secretsStub()
    })

    expect(entries.map((e) => e.text)).not.toContain(LAUNCHED_LINE)
  })
})
