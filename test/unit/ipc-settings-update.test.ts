import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { AgentFamily } from '../../src/shared/types'
import type { Runner } from '../../src/main/runners/types'

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

function setup(): {
  state: StateManager
  update: (payload: {
    reduceMotion?: boolean
    crtOverlay?: boolean
    missionAlerts?: boolean
    sound?: boolean
    soundVolume?: number
  }) => Promise<unknown>
} {
  const data: Record<string, unknown> = {}
  const store: StoreLike = {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
  const state = new StateManager(store, '/tmp/ipc-settings-update')
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

  const handler = handlers.get(IPC.SETTINGS_UPDATE)
  if (!handler) throw new Error('SETTINGS_UPDATE handler missing')
  return { state, update: (payload) => Promise.resolve(handler({}, payload)) }
}

describe('IPC.SETTINGS_UPDATE', () => {
  beforeEach(() => handlers.clear())

  it('persists motion and CRT preferences while preserving other settings', async () => {
    const { state, update } = setup()
    const projectsDir = state.getState().settings.projectsDir

    expect(await update({ reduceMotion: true, crtOverlay: false })).toEqual({ ok: true })
    expect(state.getState().settings).toMatchObject({
      projectsDir,
      reduceMotion: true,
      crtOverlay: false
    })
  })

  it('ignores non-boolean preference values', async () => {
    const { state, update } = setup()

    await update({ reduceMotion: 'yes', crtOverlay: 0 } as never)
    expect(state.getState().settings.reduceMotion).toBe(false)
    expect(state.getState().settings.crtOverlay).toBeUndefined()
  })

  it('persists missionAlerts while preserving other settings', async () => {
    const { state, update } = setup()
    const projectsDir = state.getState().settings.projectsDir

    expect(await update({ missionAlerts: false })).toEqual({ ok: true })
    expect(state.getState().settings).toMatchObject({ projectsDir, missionAlerts: false })

    expect(await update({ missionAlerts: true })).toEqual({ ok: true })
    expect(state.getState().settings.missionAlerts).toBe(true)
  })

  it('ignores a non-boolean missionAlerts value', async () => {
    const { state, update } = setup()

    await update({ missionAlerts: 'yes' } as never)
    expect(state.getState().settings.missionAlerts).toBeUndefined()
  })

  it('persists sound on/off and volume while preserving other settings', async () => {
    const { state, update } = setup()
    const projectsDir = state.getState().settings.projectsDir

    expect(await update({ sound: false, soundVolume: 0.25 })).toEqual({ ok: true })
    expect(state.getState().settings).toMatchObject({
      projectsDir,
      sound: false,
      soundVolume: 0.25
    })

    // Updating one sound field leaves the other alone.
    expect(await update({ sound: true })).toEqual({ ok: true })
    expect(state.getState().settings).toMatchObject({ sound: true, soundVolume: 0.25 })
  })

  it('clamps an out-of-range soundVolume to 0..1', async () => {
    const { state, update } = setup()

    await update({ soundVolume: 3 })
    expect(state.getState().settings.soundVolume).toBe(1)
    await update({ soundVolume: -0.5 })
    expect(state.getState().settings.soundVolume).toBe(0)
  })

  it('ignores non-numeric, NaN, and infinite soundVolume values and non-boolean sound', async () => {
    const { state, update } = setup()
    await update({ soundVolume: 0.4 })

    await update({ soundVolume: Number.NaN })
    await update({ soundVolume: Number.POSITIVE_INFINITY })
    await update({ soundVolume: '0.9', sound: 'off' } as never)
    expect(state.getState().settings.soundVolume).toBe(0.4)
    expect(state.getState().settings.sound).toBeUndefined()
  })
})
