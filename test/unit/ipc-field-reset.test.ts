import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { AgentFamily, Deployment, Facility } from '../../src/shared/types'
import type { Runner } from '../../src/main/runners/types'

const handlers = new Map<string, (event: unknown, payload?: unknown) => unknown>()

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: (event: unknown, payload?: unknown) => unknown) =>
      handlers.set(channel, handler)
    )
  },
  dialog: { showOpenDialog: vi.fn() },
  BrowserWindow: class {}
}))

import { registerIpc } from '../../src/main/ipc'
import { makeLogSink } from '../helpers/log-sink'

function setup(): { state: StateManager; reset: () => Promise<unknown> } {
  const data: Record<string, unknown> = {}
  const store: StoreLike = {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
  const state = new StateManager(store, '/tmp/ipc-field-reset')
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
    logs: makeLogSink().sink,
    fsReader: {} as never,
    secrets: {} as never
  })
  const handler = handlers.get(IPC.FIELD_RESET)
  if (!handler) throw new Error('FIELD_RESET handler missing')
  return { state, reset: () => Promise.resolve(handler({})) }
}

describe('IPC.FIELD_RESET', () => {
  beforeEach(() => handlers.clear())

  it('replaces the field with six fresh, unlinked starter facilities', async () => {
    const { state, reset } = setup()
    const oldIds = state.getState().facilities.map((facility) => facility.id)
    state.updateState((prev) => ({
      ...prev,
      facilities: [
        ...prev.facilities,
        {
          id: 'imported',
          name: 'Imported',
          path: 'C:/project',
          facilityType: 'foundry',
          tile: { x: 0, y: 0 },
          source: 'manual',
          discoveredAt: 1
        } satisfies Facility
      ]
    }))
    expect(await reset()).toEqual({ ok: true })
    const facilities = state.getState().facilities
    expect(facilities).toHaveLength(6)
    expect(facilities.every((facility) => facility.path === '')).toBe(true)
    expect(facilities.map((facility) => facility.tile)).toEqual([
      { x: 3, y: 3 },
      { x: 8, y: 3 },
      { x: 13, y: 3 },
      { x: 3, y: 13 },
      { x: 8, y: 6 },
      { x: 13, y: 13 }
    ])
    expect(facilities.every((facility) => !oldIds.includes(facility.id))).toBe(true)
  })

  it('refuses while any deployment is active', async () => {
    const { state, reset } = setup()
    const before = state.getState().facilities
    const companion = state.getState().companions[0]
    state.updateState((prev) => ({
      ...prev,
      deployments: [
        {
          id: 'active',
          companionId: companion.id,
          facilityId: before[0].id,
          taskPrompt: 'work',
          status: 'working',
          startedAt: 1
        } satisfies Deployment
      ]
    }))
    expect(await reset()).toEqual({
      ok: false,
      error: 'Deployments are active. Wait for them to finish before resetting the field.'
    })
    expect(state.getState().facilities).toBe(before)
  })
})
