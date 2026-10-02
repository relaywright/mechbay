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
import { makeLogSink } from '../helpers/log-sink'
import { MissionRegistry } from '../../src/main/mission-registry'

function setup(): {
  state: StateManager
  update: (payload: {
    reduceMotion?: boolean
    crtOverlay?: boolean
    missionAlerts?: boolean
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
    missions: new MissionRegistry(),
    logs: makeLogSink().sink,
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
})
