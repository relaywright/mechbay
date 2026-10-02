import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { DiscoveredProject } from '../../src/shared/types'

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

describe('IPC.BULK_IMPORT_RUN facility placement', () => {
  let projectsDir: string

  beforeEach(() => {
    registeredHandlers.clear()
    projectsDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mechbay-bulk-import-'))
    for (const name of ['alpha', 'bravo', 'charlie']) {
      fs.mkdirSync(path.join(projectsDir, name))
      fs.writeFileSync(path.join(projectsDir, name, 'package.json'), '{}')
    }
  })

  afterEach(() => {
    fs.rmSync(projectsDir, { recursive: true, force: true })
  })

  it('places every imported project on a distinct unoccupied tile', async () => {
    const state = new StateManager(makeInMemoryStore(), '/tmp/ipc-bulk-import-test')
    state.updateState((prev) => ({ ...prev, settings: { ...prev.settings, projectsDir } }))
    const preExistingTiles = new Set(
      state.getState().facilities.map((facility) => `${facility.tile.x},${facility.tile.y}`)
    )
    registerIpc({
      win: makeFakeWin(),
      state,
      runners: {} as never,
      missions: new MissionRegistry(),
      logs: makeLogSink().sink,
      fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
      secrets: {} as never
    })
    const scan = registeredHandlers.get(IPC.SCAN_PROJECTS)
    const handler = registeredHandlers.get(IPC.BULK_IMPORT_RUN)
    if (!scan || !handler) throw new Error('Bulk import handlers were not registered')

    // Bulk import only accepts projects the latest scan returned.
    const scanned = (await scan({}, undefined)) as DiscoveredProject[]
    const result = await handler({}, { selectedPaths: scanned.map((project) => project.path) })

    expect(result).toMatchObject({ ok: true, imported: 3 })
    const imported = state.getState().facilities.slice(-3)
    const importedTiles = imported.map((facility) => `${facility.tile.x},${facility.tile.y}`)
    expect(new Set(importedTiles)).toHaveLength(3)
    expect(importedTiles.every((tile) => !preExistingTiles.has(tile))).toBe(true)
  })
})
