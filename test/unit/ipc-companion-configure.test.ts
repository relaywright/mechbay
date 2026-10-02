import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import { FsReader } from '../../src/main/fs-reader'
import type { Runner, SpawnResult } from '../../src/main/runners/types'
import type {
  AgentFamily,
  CompanionConfigurePayload,
  CompanionConfigureResult
} from '../../src/shared/types'

/**
 * COMPANION_CONFIGURE is the IPC handler behind the RUNTIME reassignment
 * panel: it validates the companion + runtime exist, probes the new
 * runtime's availability, and persists runtime/model/cliAvailable.
 *
 * electron's ipcMain.handle is mocked so we can capture the registered
 * handler function and invoke it directly, without a real Electron process.
 */

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload: unknown) => unknown) => {
      registeredHandlers.set(channel, handler)
    })
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

// vitest hoists vi.mock() above imports, so registerIpc below picks up the
// mocked 'electron' module even though this import comes after the mock.
import { registerIpc } from '../../src/main/ipc'
import { makeLogSink } from '../helpers/log-sink'

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

function stubRunner(available: boolean): Runner {
  return {
    isAvailable: async () => available,
    spawn: async (): Promise<SpawnResult> => {
      throw new Error('not used in this test')
    }
  }
}

function makeFakeWin(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

async function invokeConfigure(
  handler: (event: unknown, payload: unknown) => unknown,
  payload: CompanionConfigurePayload
): Promise<CompanionConfigureResult> {
  return (await handler({}, payload)) as CompanionConfigureResult
}

describe('IPC.COMPANION_CONFIGURE handler', () => {
  beforeEach(() => {
    registeredHandlers.clear()
  })

  function setup(runnerAvailability: Partial<Record<AgentFamily, boolean>> = {}): {
    state: StateManager
    handler: (event: unknown, payload: unknown) => unknown
  } {
    const store = makeInMemoryStore()
    const state = new StateManager(store, '/tmp/ipc-companion-configure-test')
    const runners: Record<AgentFamily, Runner> = {
      claude: stubRunner(runnerAvailability.claude ?? true),
      codex: stubRunner(runnerAvailability.codex ?? true),
      kimi: stubRunner(runnerAvailability.kimi ?? false),
      gemini: stubRunner(runnerAvailability.gemini ?? true),
      hermes: stubRunner(runnerAvailability.hermes ?? false)
    }
    const fsReader = new FsReader([])
    registerIpc({
      win: makeFakeWin(),
      state,
      runners,
      fsReader,
      secrets: {} as never,
      logs: makeLogSink().sink
    })
    const handler = registeredHandlers.get(IPC.COMPANION_CONFIGURE)
    if (!handler) throw new Error('COMPANION_CONFIGURE handler was not registered')
    return { state, handler }
  }

  it('success path updates runtime, model, and cliAvailable', async () => {
    const { state, handler } = setup({ gemini: true })
    const companion = state.getState().companions.find((c) => c.family === 'codex')!

    const result = await invokeConfigure(handler, {
      companionId: companion.id,
      runtime: 'gemini',
      model: 'gemini-3-pro'
    })

    expect(result).toEqual({ ok: true, cliAvailable: true })
    const updated = state.getState().companions.find((c) => c.id === companion.id)!
    expect(updated.runtime).toBe('gemini')
    expect(updated.model).toBe('gemini-3-pro')
    expect(updated.cliAvailable).toBe(true)
  })

  it('reflects a false availability probe for the new runtime', async () => {
    const { state, handler } = setup({ kimi: false })
    const companion = state.getState().companions.find((c) => c.family === 'claude')!

    const result = await invokeConfigure(handler, {
      companionId: companion.id,
      runtime: 'kimi'
    })

    expect(result).toEqual({ ok: true, cliAvailable: false })
    const updated = state.getState().companions.find((c) => c.id === companion.id)!
    expect(updated.runtime).toBe('kimi')
    expect(updated.cliAvailable).toBe(false)
  })

  it('returns ok:false for an unknown companion id', async () => {
    const { handler } = setup()

    const result = await invokeConfigure(handler, {
      companionId: 'not-a-real-companion-id',
      runtime: 'codex'
    })

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('not-a-real-companion-id')
  })

  it('returns ok:false for an unknown runtime', async () => {
    const { state, handler } = setup()
    const companion = state.getState().companions[0]

    const result = await invokeConfigure(handler, {
      companionId: companion.id,
      runtime: 'nonexistent-family' as AgentFamily
    })

    expect(result.ok).toBe(false)
    expect((result as { ok: false; error: string }).error).toContain('nonexistent-family')
    // State must be untouched on validation failure.
    const unchanged = state.getState().companions.find((c) => c.id === companion.id)!
    expect(unchanged.runtime).toBeUndefined()
  })

  it('treats an empty model string as clearing the override', async () => {
    const { state, handler } = setup()
    const companion = state.getState().companions.find((c) => c.family === 'claude')!

    // First set a model override.
    await invokeConfigure(handler, {
      companionId: companion.id,
      runtime: 'claude',
      model: 'claude-opus-4-8'
    })
    expect(state.getState().companions.find((c) => c.id === companion.id)!.model).toBe(
      'claude-opus-4-8'
    )

    // Now clear it with an empty (whitespace-only) string.
    const result = await invokeConfigure(handler, {
      companionId: companion.id,
      runtime: 'claude',
      model: '   '
    })

    expect(result.ok).toBe(true)
    const cleared = state.getState().companions.find((c) => c.id === companion.id)!
    expect(cleared.model).toBeUndefined()
  })

  it('updates a trimmed name without changing runtime configuration', async () => {
    const { state, handler } = setup()
    const companion = state.getState().companions[0]
    const result = await invokeConfigure(handler, {
      companionId: companion.id,
      name: '  Scout  '
    })
    expect(result.ok).toBe(true)
    const updated = state.getState().companions[0]
    expect(updated.name).toBe('Scout')
    expect(updated.runtime).toBeUndefined()
  })

  it.each(['', 'x'.repeat(25)])('rejects invalid name %j', async (name) => {
    const { state, handler } = setup()
    const companion = state.getState().companions[0]
    expect(await invokeConfigure(handler, { companionId: companion.id, name })).toEqual({
      ok: false,
      error: 'Name must be 1-24 characters'
    })
  })
})
