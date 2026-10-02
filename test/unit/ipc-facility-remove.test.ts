import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { AgentFamily, Deployment, SimpleActionResult } from '../../src/shared/types'
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

const store = (): StoreLike => {
  const data: Record<string, unknown> = {}
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
}

function setup(): {
  state: StateManager
  remove: (payload: { facilityId: string }) => Promise<SimpleActionResult>
} {
  const state = new StateManager(store(), '/tmp/ipc-facility-remove')
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
  const handler = handlers.get(IPC.FACILITY_REMOVE)
  if (!handler) throw new Error('FACILITY_REMOVE handler missing')
  return {
    state,
    remove: (payload) => Promise.resolve(handler({}, payload) as SimpleActionResult)
  }
}

describe('IPC.FACILITY_REMOVE', () => {
  beforeEach(() => handlers.clear())

  it('removes an idle facility from state', async () => {
    const { state, remove } = setup()
    const facility = state.getState().facilities[0]
    expect(await remove({ facilityId: facility.id })).toEqual({ ok: true })
    expect(state.getState().facilities.some((candidate) => candidate.id === facility.id)).toBe(
      false
    )
  })

  it('refuses to remove a facility with an active deployment', async () => {
    const { state, remove } = setup()
    const facility = state.getState().facilities[0]
    const companion = state.getState().companions[0]
    state.updateState((prev) => ({
      ...prev,
      deployments: [
        {
          id: 'active-deployment',
          companionId: companion.id,
          facilityId: facility.id,
          taskPrompt: 'work',
          status: 'queued',
          startedAt: Date.now()
        } satisfies Deployment
      ]
    }))
    expect(await remove({ facilityId: facility.id })).toEqual({
      ok: false,
      error: `«${facility.name}» has an active deployment. Wait for it to finish first.`
    })
    expect(state.getState().facilities.some((candidate) => candidate.id === facility.id)).toBe(true)
  })
})
