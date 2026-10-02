import { beforeEach, describe, expect, it, vi } from 'vitest'
import { dialog, type BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

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

function setup(): { state: StateManager; handler: (event: unknown, payload: unknown) => unknown } {
  const state = new StateManager(makeInMemoryStore(), '/tmp/ipc-facility-link-test')
  const win = {
    isDestroyed: () => false,
    webContents: { send: vi.fn() }
  } as unknown as BrowserWindow
  registerIpc({
    win,
    state,
    runners: {} as never,
    logs: makeLogSink().sink,
    fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
    secrets: {} as never
  })
  const handler = registeredHandlers.get(IPC.FACILITY_LINK)
  if (!handler) throw new Error('FACILITY_LINK handler was not registered')
  return { state, handler }
}

describe('IPC.FACILITY_LINK', () => {
  beforeEach(() => {
    registeredHandlers.clear()
    vi.mocked(dialog.showOpenDialog).mockReset()
  })

  it('links an unlinked facility to the picked project directory', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({
      canceled: false,
      filePaths: ['C:/fake/proj']
    })
    const { state, handler } = setup()
    const facility = state.getState().facilities[0]

    const result = await handler({}, { facilityId: facility.id })

    expect(result).toMatchObject({ id: facility.id, path: 'C:/fake/proj' })
    expect(state.getState().facilities[0].path).toBe('C:/fake/proj')
  })

  it('leaves the facility unchanged when the picker is cancelled', async () => {
    vi.mocked(dialog.showOpenDialog).mockResolvedValue({ canceled: true, filePaths: [] })
    const { state, handler } = setup()
    const facility = state.getState().facilities[0]

    await expect(handler({}, { facilityId: facility.id })).resolves.toBeNull()
    expect(state.getState().facilities[0].path).toBe('')
  })

  it('returns an already-linked facility without opening the picker', async () => {
    const { state, handler } = setup()
    const facility = state.getState().facilities[0]
    const linked = { ...facility, path: 'C:/already/linked' }
    state.updateState((current) => ({
      ...current,
      facilities: current.facilities.map((candidate) =>
        candidate.id === linked.id ? linked : candidate
      )
    }))

    await expect(handler({}, { facilityId: linked.id })).resolves.toEqual(linked)
    expect(dialog.showOpenDialog).not.toHaveBeenCalled()
  })
})
