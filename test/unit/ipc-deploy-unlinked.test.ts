import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { Runner } from '../../src/main/runners/types'
import type { AgentFamily } from '../../src/shared/types'

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

import { registerIpc } from '../../src/main/ipc'
import { makeLogSink } from '../helpers/log-sink'
import { MissionRegistry } from '../../src/main/mission-registry'

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value
    },
    has: (key: string) => key in data
  }
}

function makeFakeWin(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

describe('IPC.DEPLOY_START unlinked facility guard', () => {
  beforeEach(() => {
    registeredHandlers.clear()
  })

  it('rejects an unlinked facility without creating or spawning a deployment', async () => {
    const state = new StateManager(makeInMemoryStore(), '/tmp/ipc-deploy-unlinked-test')
    const companion = state.getState().companions[0]
    const facility = state.getState().facilities[0]
    const spawn = vi.fn()
    const runner: Runner = { isAvailable: async () => true, spawn }
    const runners = Object.fromEntries(
      (['claude', 'codex', 'kimi', 'gemini', 'hermes'] as AgentFamily[]).map((family) => [
        family,
        runner
      ])
    ) as Record<AgentFamily, Runner>

    registerIpc({
      win: makeFakeWin(),
      state,
      runners,
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
      secrets: {} as never
    })
    const handler = registeredHandlers.get(IPC.DEPLOY_START)
    if (!handler) throw new Error('DEPLOY_START handler was not registered')

    const deploymentsBefore = state.getState().deployments
    await expect(
      handler(
        {},
        {
          companionId: companion.id,
          facilityId: facility.id,
          taskPrompt: 'Inspect the project'
        }
      )
    ).rejects.toThrow("isn't linked")

    expect(state.getState().deployments).toEqual(deploymentsBefore)
    expect(spawn).not.toHaveBeenCalled()
  })
})
