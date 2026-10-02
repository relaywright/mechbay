import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { BrowserWindow } from 'electron'
import { IPC } from '../../src/shared/ipc-channels'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import type { BulkImportRunResult, DiscoveredProject } from '../../src/shared/types'

/**
 * A bulk-imported folder joins the File Browser's read allowlist and
 * becomes a deploy working directory, so the renderer may only import
 * folders the main process itself found in the most recent scan of the
 * projects folder. Anything else is refused and state stays untouched.
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

import { registerIpc } from '../../src/main/ipc'

const REJECTED = { ok: false, error: 'Scan again and pick projects from the list.' }

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

let root: string
let projectsDir: string
let state: StateManager

function scan(rootDir?: unknown): Promise<DiscoveredProject[]> {
  const handler = registeredHandlers.get(IPC.SCAN_PROJECTS)
  if (!handler) throw new Error('SCAN_PROJECTS handler was not registered')
  return handler({}, rootDir) as Promise<DiscoveredProject[]>
}

function bulkImport(selectedPaths: string[]): Promise<BulkImportRunResult> {
  const handler = registeredHandlers.get(IPC.BULK_IMPORT_RUN)
  if (!handler) throw new Error('BULK_IMPORT_RUN handler was not registered')
  return handler({}, { selectedPaths }) as Promise<BulkImportRunResult>
}

function makeProject(parent: string, name: string): string {
  const dir = path.join(parent, name)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'package.json'), '{}')
  return dir
}

beforeEach(() => {
  registeredHandlers.clear()
  root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'mechbay-bulk-trust-')))
  projectsDir = path.join(root, 'Projects')
  makeProject(projectsDir, 'alpha')
  makeProject(projectsDir, 'bravo')
  state = new StateManager(makeInMemoryStore(), path.join(root, 'userData'))
  state.updateState((prev) => ({ ...prev, settings: { ...prev.settings, projectsDir } }))
  registerIpc({
    win: { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow,
    state,
    runners: {} as never,
    fsReader: { readDir: vi.fn(), readFile: vi.fn(), updateWhitelist: vi.fn() } as never,
    secrets: {} as never
  })
})

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true })
})

describe('IPC.SCAN_PROJECTS', () => {
  it('always scans the projects folder from settings, ignoring a renderer-supplied root', async () => {
    const elsewhere = path.join(root, 'Elsewhere')
    makeProject(elsewhere, 'zulu')

    const found = await scan(elsewhere)

    expect(found.map((project) => project.name)).toEqual(['alpha', 'bravo'])
  })
})

describe('IPC.BULK_IMPORT_RUN only imports folders from the latest scan', () => {
  it('imports a scanned project', async () => {
    const [alpha] = await scan()

    const result = await bulkImport([alpha.path])

    expect(result).toMatchObject({ ok: true, imported: 1 })
    expect(state.getState().facilities.at(-1)).toMatchObject({
      name: 'alpha',
      path: path.join(projectsDir, 'alpha'),
      source: 'auto-scan'
    })
  })

  it('rejects an import before any scan has happened', async () => {
    const before = state.getState().facilities

    await expect(bulkImport([path.join(projectsDir, 'alpha')])).resolves.toEqual(REJECTED)
    expect(state.getState().facilities).toEqual(before)
  })

  it('rejects a folder the scan never returned, such as the home folder', async () => {
    await scan()
    const before = state.getState().facilities

    await expect(bulkImport([os.homedir()])).resolves.toEqual(REJECTED)
    expect(state.getState().facilities).toEqual(before)
  })

  it('rejects the whole request when any one path is unscanned', async () => {
    const [alpha] = await scan()
    const before = state.getState().facilities

    await expect(bulkImport([alpha.path, root])).resolves.toEqual(REJECTED)
    expect(state.getState().facilities).toEqual(before)
  })

  it('rejects a folder that only appeared after the latest scan', async () => {
    await scan()
    const late = makeProject(projectsDir, 'charlie')

    await expect(bulkImport([late])).resolves.toEqual(REJECTED)
  })

  it('accepts another spelling of a scanned path only when it resolves to it', async () => {
    const [alpha] = await scan()

    await expect(bulkImport([alpha.path + path.sep])).resolves.toMatchObject({
      ok: true,
      imported: 1
    })
    await expect(
      bulkImport([path.join(projectsDir, 'alpha', '..', '..', 'Projects', 'bravo')])
    ).resolves.toMatchObject({ ok: true, imported: 1 })
    await expect(bulkImport([path.join(projectsDir, 'alpha', '..')])).resolves.toEqual(REJECTED)
  })

  it.runIf(process.platform === 'win32')(
    'accepts a different letter case of a scanned path on Windows',
    async () => {
      const [alpha] = await scan()

      await expect(bulkImport([alpha.path.toUpperCase()])).resolves.toMatchObject({
        ok: true,
        imported: 1
      })
      expect(state.getState().facilities.at(-1)?.path).toBe(path.join(projectsDir, 'alpha'))
    }
  )

  it('skips a scanned project that is already linked to a facility', async () => {
    const [alpha] = await scan()
    await bulkImport([alpha.path])
    const before = state.getState().facilities

    await expect(bulkImport([alpha.path, alpha.path + path.sep])).resolves.toMatchObject({
      ok: true,
      imported: 0
    })
    expect(state.getState().facilities).toEqual(before)
  })
})
