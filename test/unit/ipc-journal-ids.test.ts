import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

/**
 * The Journal handlers only act on a mech that exists in state. A
 * well-formed ID that no companion owns (or any path-like string) gets
 * "Unknown mech." and the disk is never touched.
 */

const registeredHandlers = new Map<string, (event: unknown, payload: unknown) => unknown>()
let userData = ''

vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => userData) },
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
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
}

function makeFakeWin(): BrowserWindow {
  return {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
}

function handler(channel: string): (event: unknown, payload: unknown) => unknown {
  const registered = registeredHandlers.get(channel)
  if (!registered) throw new Error(`${channel} handler was not registered`)
  return registered
}

let state: StateManager

beforeEach(() => {
  registeredHandlers.clear()
  userData = fs.mkdtempSync(path.join(os.tmpdir(), 'mechbay-ipc-journal-'))
  state = new StateManager(makeInMemoryStore(), userData)
  registerIpc({
    win: makeFakeWin(),
    state,
    runners: {} as never,
    missions: new MissionRegistry(),
    logs: makeLogSink().sink,
    fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
    secrets: {} as never
  })
})

afterEach(() => {
  fs.rmSync(userData, { recursive: true, force: true })
})

describe('Journal IPC only accepts companions that exist', () => {
  it.each(['01JNOTACOMPANION0000000000', '../../outside', '..', ''])(
    'rejects companion ID %j on read, write and memory read',
    async (companionId) => {
      const unknown = { ok: false, error: 'Unknown mech.' }

      await expect(handler(IPC.SOUL_READ)({}, { companionId })).resolves.toEqual(unknown)
      await expect(
        handler(IPC.SOUL_WRITE)({}, { companionId, content: 'planted' })
      ).resolves.toEqual(unknown)
      await expect(handler(IPC.MEMORY_READ)({}, { companionId })).resolves.toEqual(unknown)
      expect(fs.readdirSync(userData)).toEqual([])
    }
  )

  it('reads and writes the soul of a companion in state', async () => {
    const companionId = state.getState().companions[0].id

    await expect(
      handler(IPC.SOUL_WRITE)({}, { companionId, content: '# Soul\nSteady.' })
    ).resolves.toEqual({ ok: true })
    await expect(handler(IPC.SOUL_READ)({}, { companionId })).resolves.toEqual({
      ok: true,
      content: '# Soul\nSteady.'
    })
  })
})
