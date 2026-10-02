import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import path from 'path'
import { IPC } from '../shared/ipc-channels'
import type {
  AgentFamily,
  AppMode,
  Companion,
  Deployment,
  DeploymentStatus,
  Facility,
  LogChunk,
  SoulReadPayload,
  SoulReadResult,
  SoulWritePayload,
  SoulWriteResult,
  MemoryReadPayload,
  MemoryReadResult,
  BulkImportRunPayload,
  BulkImportRunResult,
  CompanionConfigurePayload,
  CompanionConfigureResult,
  DiffFileGetResult
} from '../shared/types'
import { seedFacilities, type StateManager } from './state-manager'
import type { SecretsManager } from './secrets'
import type { Runner } from './runners/types'
import { ulid } from '../shared/ulid'
import { scanProjects, type DiscoveredProject } from './project-scanner'
import {
  assembleSystemPrompt,
  appendMemoryEntry,
  readSoul,
  writeSoul,
  readMemory
} from './soul-memory'
import type { FsReader, FsNode } from './fs-reader'
import { facilityTypeFromName } from './facility-type-hash'
import { NarrationParser } from './log-narration-parser'
import { captureGitBaseline, computeDiffSummary, readFilePatch, resolveInRepo } from './git-diff'

const GRID_W = 16
const GRID_H = 16

export interface IpcDeps {
  win: BrowserWindow
  state: StateManager
  runners: Record<AgentFamily, Runner>
  fsReader: FsReader
  secrets: SecretsManager
  demoMode?: boolean
}

const FS_DIR_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'out']

const ACTIVE_STATUSES: DeploymentStatus[] = ['walking-to', 'working', 'awaiting-input', 'returning']
const BLOCKING_STATUSES: DeploymentStatus[] = [...ACTIVE_STATUSES, 'queued']

export function registerIpc(opts: IpcDeps): void {
  const { win, state, runners, fsReader, secrets } = opts

  ipcMain.handle(IPC.APP_MODE_GET, (): AppMode => ({ demo: opts.demoMode ?? false }))

  // Filesystem: whitelist-guarded read-only access for the File Browser.
  // Handlers simply delegate to FsReader; all security lives there.
  ipcMain.handle(IPC.FS_READ_DIR, async (_e, args: { path: string }): Promise<FsNode[]> => {
    return fsReader.readDir(args.path, { ignore: FS_DIR_IGNORE })
  })
  ipcMain.handle(IPC.FS_READ_FILE, async (_e, args: { path: string }): Promise<string> => {
    return fsReader.readFile(args.path)
  })

  // Manual facility placement: user clicked an empty iso tile, we show the
  // OS directory picker, and if they choose one we add a new facility
  // bound to that directory at the clicked tile. The hash-based type
  // selection gives the new facility a stable sprite/archetype without
  // needing user input. Returns the new facility, or null if the user
  // cancelled / the tile was invalid.
  ipcMain.handle(
    IPC.FACILITY_ADD_FROM_PICKER,
    async (_e, args: { tile: { x: number; y: number } }): Promise<Facility | null> => {
      const { tile } = args
      if (
        !Number.isInteger(tile.x) ||
        !Number.isInteger(tile.y) ||
        tile.x < 0 ||
        tile.x >= GRID_W ||
        tile.y < 0 ||
        tile.y >= GRID_H
      ) {
        throw new Error(`Invalid tile (${tile.x}, ${tile.y})`)
      }
      const current = state.getState()
      if (current.facilities.some((f) => f.tile.x === tile.x && f.tile.y === tile.y)) {
        throw new Error(`Tile (${tile.x}, ${tile.y}) is already occupied`)
      }

      const result = await dialog.showOpenDialog(win, {
        title: 'Pick a project directory',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null
      const picked = result.filePaths[0]
      const name = path.basename(picked)

      const facility: Facility = {
        id: ulid(),
        name,
        path: picked,
        facilityType: facilityTypeFromName(name),
        tile,
        source: 'manual',
        discoveredAt: Date.now()
      }
      state.updateState((prev) => ({ ...prev, facilities: [...prev.facilities, facility] }))
      return facility
    }
  )

  ipcMain.handle(
    IPC.FACILITY_LINK,
    async (_e, args: { facilityId: string }): Promise<Facility | null> => {
      const facility = state
        .getState()
        .facilities.find((candidate) => candidate.id === args.facilityId)
      if (!facility) throw new Error(`Facility not found: ${args.facilityId}`)
      if (facility.path) return facility

      const result = await dialog.showOpenDialog(win, {
        title: 'Link a project directory',
        properties: ['openDirectory']
      })
      if (result.canceled || result.filePaths.length === 0) return null

      const linked = { ...facility, path: result.filePaths[0] }
      state.updateState((prev) => ({
        ...prev,
        facilities: prev.facilities.map((candidate) =>
          candidate.id === linked.id ? linked : candidate
        )
      }))
      return linked
    }
  )

  ipcMain.handle(IPC.FACILITY_REMOVE, (_e, args: { facilityId: string }) => {
    const current = state.getState()
    const facility = current.facilities.find((candidate) => candidate.id === args.facilityId)
    if (!facility) return { ok: false, error: `Facility not found: ${args.facilityId}` }
    const active = current.deployments.some(
      (deployment) =>
        deployment.facilityId === facility.id && BLOCKING_STATUSES.includes(deployment.status)
    )
    if (active) {
      return {
        ok: false,
        error: `«${facility.name}» has an active deployment. Wait for it to finish first.`
      }
    }
    state.updateState((prev) => ({
      ...prev,
      facilities: prev.facilities.filter((candidate) => candidate.id !== facility.id)
    }))
    return { ok: true }
  })

  ipcMain.handle(IPC.FIELD_RESET, () => {
    if (
      state
        .getState()
        .deployments.some((deployment) => BLOCKING_STATUSES.includes(deployment.status))
    ) {
      return {
        ok: false,
        error: 'Deployments are active. Wait for them to finish before resetting the field.'
      }
    }
    state.updateState((prev) => ({ ...prev, facilities: seedFacilities() }))
    return { ok: true }
  })

  ipcMain.handle(IPC.SECRETS_SET, (_e, args: { runtime: AgentFamily; value: string }) =>
    secrets.setSecret(args.runtime, args.value)
  )
  ipcMain.handle(IPC.SECRETS_STATUS, () => secrets.getStatus())

  ipcMain.handle(
    IPC.SETTINGS_UPDATE,
    (_e, patch: { reduceMotion?: boolean; crtOverlay?: boolean; missionAlerts?: boolean }) => {
      state.updateState((prev) => ({
        ...prev,
        settings: {
          ...prev.settings,
          ...(typeof patch.reduceMotion === 'boolean' ? { reduceMotion: patch.reduceMotion } : {}),
          ...(typeof patch.crtOverlay === 'boolean' ? { crtOverlay: patch.crtOverlay } : {}),
          ...(typeof patch.missionAlerts === 'boolean'
            ? { missionAlerts: patch.missionAlerts }
            : {})
        }
      }))
      return { ok: true }
    }
  )

  // Per-file diff patch for the debrief's DiffViewer. Security boundary:
  // args.path is only ever honored if it exactly matches one of the
  // deployment's own diffFiles — the renderer must never be able to walk
  // git into reading arbitrary files off disk. The resolved-path check
  // below is defense in depth on top of that allowlist, not a substitute
  // for it.
  ipcMain.handle(
    IPC.DIFF_FILE_GET,
    async (_e, args: { deploymentId: string; path: string }): Promise<DiffFileGetResult> => {
      if (
        typeof args?.deploymentId !== 'string' ||
        args.deploymentId.length === 0 ||
        typeof args?.path !== 'string' ||
        args.path.length === 0
      ) {
        return { ok: false, error: 'Invalid diff file request' }
      }

      const s = state.getState()
      const deployment = s.deployments.find((d) => d.id === args.deploymentId)
      if (!deployment) {
        return { ok: false, error: `Deployment not found: ${args.deploymentId}` }
      }

      const known = deployment.diffFiles?.some((file) => file.path === args.path) ?? false
      if (!known) {
        return { ok: false, error: 'That path is not part of this deployment’s diff' }
      }

      const facility = s.facilities.find((f) => f.id === deployment.facilityId)
      if (!facility || !facility.path) {
        return { ok: false, error: 'Facility is missing or unlinked' }
      }

      // Defense in depth on top of the diffFiles allowlist above: resolveInRepo
      // realpath-checks containment so a symlinked ancestor directory (or a
      // symlinked facility root itself) can't be used to walk outside it.
      const resolved = await resolveInRepo(facility.path, args.path)
      if (!resolved) {
        return { ok: false, error: 'Path escapes the facility directory' }
      }

      try {
        const patch = await readFilePatch(facility.path, deployment.baselineSha ?? null, args.path)
        if (!patch) return { ok: false, error: 'Unable to read diff for this file' }
        return { ok: true, patch }
      } catch (err) {
        return { ok: false, error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  // Broadcast every state change to renderer.
  state.on('stateChanged', (s) => {
    if (!win.isDestroyed()) {
      win.webContents.send(IPC.STATE_SUBSCRIBE, s)
    }
  })

  ipcMain.handle(IPC.STATE_GET, () => state.getState())

  // Project scanner — returns a list of discovered project directories
  // under a given root (defaults to state.settings.projectsDir). The
  // renderer receives raw DiscoveredProject records and decides what to
  // do with them (picker UI, facility binding, etc.). We intentionally
  // DO NOT auto-populate facilities from scan results — how scanned
  // projects map onto the 6 seeded archetype-facilities is a design
  // decision the user needs to make. See docs/overnight-prep/
  // 2026-04-17-project-scanner-facility-binding.md for the analysis.
  ipcMain.handle(IPC.SCAN_PROJECTS, async (_e, rootDir?: string): Promise<DiscoveredProject[]> => {
    const s = state.getState()
    const root = rootDir ?? s.settings.projectsDir
    const results = await scanProjects(root, s.settings.ignoredMarkers)
    state.updateState((prev) => ({ ...prev, lastScanAt: Date.now() }))
    return results
  })

  ipcMain.handle(
    IPC.DEPLOY_START,
    async (
      _e,
      args: {
        companionId: string
        facilityId: string
        taskPrompt: string
        quickPromptUsed?: string
      }
    ) => {
      const deploymentId = ulid()
      const s = state.getState()
      const companion = s.companions.find((c) => c.id === args.companionId)
      const facility = s.facilities.find((f) => f.id === args.facilityId)
      if (!companion) throw new Error(`Companion not found: ${args.companionId}`)
      if (!facility) throw new Error(`Facility not found: ${args.facilityId}`)
      if (!facility.path) {
        throw new Error(
          `${facility.name} isn't linked to a project folder yet. Click the building to link it to a project directory, or use BULK IMPORT (top bar).`
        )
      }

      const activeCount = s.deployments.filter((d) => ACTIVE_STATUSES.includes(d.status)).length
      const status: DeploymentStatus =
        activeCount >= s.settings.concurrencyCap ? 'queued' : 'walking-to'

      const deployment: Deployment = {
        id: deploymentId,
        companionId: companion.id,
        facilityId: facility.id,
        taskPrompt: args.taskPrompt,
        quickPromptUsed: args.quickPromptUsed,
        status,
        startedAt: Date.now()
      }

      state.updateState((prev) => ({
        ...prev,
        deployments: [deployment, ...prev.deployments].slice(0, 200)
      }))

      if (status === 'walking-to') {
        // Fire and forget — execution updates state asynchronously. Attach
        // a catch so sync throws (e.g. runner lookup miss) don't become
        // unhandled rejections; they land in the deployment as 'failed'.
        executeDeployment(deploymentId, companion, facility, args.taskPrompt, opts).catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          console.error(`[ipc] executeDeployment(${deploymentId}) crashed:`, message)
          state.updateState((prev) => ({
            ...prev,
            deployments: prev.deployments.map((d) =>
              d.id === deploymentId
                ? { ...d, status: 'failed', completedAt: Date.now(), summary: message }
                : d
            )
          }))
        })
      }
      return { deploymentId, status }
    }
  )

  // Soul/Memory read/write handlers for Journal tab. Pass the SAME base
  // dir the StateManager seeded companion.soulPath/memoryPath with —
  // soul-memory's default (os.homedir()) resolves to a different tree
  // than boot scaffolding, so omitting it splits Journal reads/writes
  // from the files deployments actually inject.
  ipcMain.handle(IPC.SOUL_READ, async (_e, payload: SoulReadPayload): Promise<SoulReadResult> => {
    return readSoul(payload.companionId, app.getPath('userData'))
  })

  ipcMain.handle(
    IPC.SOUL_WRITE,
    async (_e, payload: SoulWritePayload): Promise<SoulWriteResult> => {
      return writeSoul(payload.companionId, payload.content, app.getPath('userData'))
    }
  )

  ipcMain.handle(
    IPC.MEMORY_READ,
    async (_e, payload: MemoryReadPayload): Promise<MemoryReadResult> => {
      return readMemory(payload.companionId, app.getPath('userData'))
    }
  )

  // Bulk Import handler — places multiple facilities at empty tiles
  ipcMain.handle(
    IPC.BULK_IMPORT_RUN,
    async (_e, payload: BulkImportRunPayload): Promise<BulkImportRunResult> => {
      const s = state.getState()
      const importedFacilities: Facility[] = []
      const occupied = new Set(s.facilities.map((f) => `${f.tile.x},${f.tile.y}`))

      for (const projectPath of payload.selectedPaths) {
        // Find an empty tile
        let emptyTile: { x: number; y: number } | null = null
        for (let y = 0; y < GRID_H && !emptyTile; y++) {
          for (let x = 0; x < GRID_W && !emptyTile; x++) {
            if (!occupied.has(`${x},${y}`)) {
              emptyTile = { x, y }
            }
          }
        }
        if (!emptyTile) {
          return { ok: false, error: 'No empty tiles available for bulk import' }
        }

        const name = path.basename(projectPath)
        const facility: Facility = {
          id: ulid(),
          name,
          path: projectPath,
          facilityType: facilityTypeFromName(name),
          tile: emptyTile,
          source: 'auto-scan',
          discoveredAt: Date.now()
        }
        importedFacilities.push(facility)
        // Update occupied set for next iteration
        occupied.add(`${emptyTile.x},${emptyTile.y}`)
      }

      // Batch update state with all new facilities
      if (importedFacilities.length > 0) {
        state.updateState((prev) => ({
          ...prev,
          facilities: [...prev.facilities, ...importedFacilities]
        }))
      }

      return { ok: true, imported: importedFacilities.length, facilities: importedFacilities }
    }
  )

  // Runtime reassignment: let the user point a companion at a different
  // agent family (and optionally override the model) without touching
  // its `family` identity — `family` stays the mech's "native" runtime
  // for display purposes, `runtime` is the effective one.
  ipcMain.handle(
    IPC.COMPANION_CONFIGURE,
    async (_e, payload: CompanionConfigurePayload): Promise<CompanionConfigureResult> => {
      const { companionId, runtime } = payload

      const s = state.getState()
      const companion = s.companions.find((c) => c.id === companionId)
      if (!companion) {
        return { ok: false, error: `Companion not found: ${companionId}` }
      }
      const name = payload.name?.trim()
      if (payload.name !== undefined && (!name || name.length > 24)) {
        return { ok: false, error: 'Name must be 1-24 characters' }
      }
      if (runtime === undefined) {
        if (name) {
          state.updateState((prev) => ({
            ...prev,
            companions: prev.companions.map((candidate) =>
              candidate.id === companionId ? { ...candidate, name } : candidate
            )
          }))
        }
        return { ok: true, cliAvailable: companion.cliAvailable }
      }
      if (!(runtime in runners)) {
        return { ok: false, error: `Unknown runtime: ${runtime}` }
      }

      let cliAvailable: boolean
      try {
        cliAvailable = await runners[runtime].isAvailable()
      } catch (err) {
        console.warn(`[ipc] isAvailable() threw for runtime ${runtime}:`, err)
        cliAvailable = false
      }

      state.updateState((prev) => ({
        ...prev,
        companions: prev.companions.map((c) =>
          c.id === companionId
            ? {
                ...c,
                runtime,
                model: payload.model?.trim() || undefined,
                cliAvailable,
                ...(name ? { name } : {})
              }
            : c
        )
      }))

      return { ok: true, cliAvailable }
    }
  )
}

export async function executeDeployment(
  deploymentId: string,
  companion: Companion,
  facility: Facility,
  taskPrompt: string,
  opts: IpcDeps
): Promise<void> {
  const { win, state, runners } = opts
  const effectiveRuntime = companion.runtime ?? companion.family
  const runner = runners[effectiveRuntime]
  if (!runner) {
    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) =>
        d.id === deploymentId
          ? {
              ...d,
              status: 'failed',
              completedAt: Date.now(),
              summary: `No runner registered for runtime: ${effectiveRuntime}`
            }
          : d
      )
    }))
    return
  }

  // Transition to working
  state.updateState((prev) => ({
    ...prev,
    deployments: prev.deployments.map((d) =>
      d.id === deploymentId ? { ...d, status: 'working' } : d
    )
  }))

  let exitCode: number
  let baselineSha: string | null = null
  try {
    // Wrap the task prompt in the companion's soul + memory so every
    // deploy carries personality context + past-run history. If assembly
    // throws (missing files — shouldn't happen after boot scaffolding but
    // belt-and-suspenders), the outer catch below records it as failed.
    const fullPrompt = assembleSystemPrompt(
      companion.name,
      { soulPath: companion.soulPath, memoryPath: companion.memoryPath },
      taskPrompt
    )
    baselineSha = await captureGitBaseline(facility.path)
    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) =>
        d.id === deploymentId && baselineSha ? { ...d, baselineSha } : d
      )
    }))

    const result = await runner.spawn(facility.path, fullPrompt, {
      model: companion.model,
      env: opts.secrets.envFor(effectiveRuntime)
    })
    const parser = new NarrationParser()

    const emit = (p: {
      stream: LogChunk['stream']
      text: string
      thoughtKind?: 'intent' | 'findings'
    }): void => {
      const logChunk: LogChunk = {
        id: ulid(),
        deploymentId,
        timestamp: Date.now(),
        stream: p.stream,
        text: p.text,
        ...(p.thoughtKind ? { thoughtKind: p.thoughtKind } : {})
      }
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.LOG_STREAM, logChunk)
      }
      state.updateState((prev) => ({
        ...prev,
        logChunks: [...prev.logChunks, logChunk].slice(-5000)
      }))
    }

    // Drain stream BEFORE awaiting exit — exit may resolve while chunks
    // are still queued. Sequential await guarantees all chunks reach renderer.
    for await (const chunk of result.stream) {
      for (const parsed of parser.feed(chunk)) emit(parsed)
    }
    // Flush any partial trailing line left in the parser buffers.
    for (const parsed of parser.flush()) emit(parsed)

    exitCode = await result.exit
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) =>
        d.id === deploymentId
          ? { ...d, status: 'failed', completedAt: Date.now(), summary: message }
          : d
      )
    }))
    recordMemory(companion, facility, taskPrompt, `Failed before exit. ${message}`)
    return
  }

  const finalStatus: DeploymentStatus = exitCode === 0 ? 'completed' : 'failed'
  const diff = await computeDiffSummary(facility.path, baselineSha)
  const diffFields = diff
    ? {
        diffStats: {
          filesChanged: diff.filesChanged,
          insertions: diff.insertions,
          deletions: diff.deletions
        },
        diffFiles: diff.files
      }
    : {}
  const outcome =
    exitCode === 0
      ? diff === null
        ? 'Completed. (No git repository, so no diff is available.)'
        : diff.filesChanged === 0
          ? 'Completed. No file changes detected.'
          : `Completed. ${diff.filesChanged} file${diff.filesChanged === 1 ? '' : 's'} changed, +${diff.insertions} −${diff.deletions}.`
      : `Failed. Exit ${exitCode}.`
  state.updateState((prev) => ({
    ...prev,
    deployments: prev.deployments.map((d) =>
      d.id === deploymentId
        ? {
            ...d,
            status: finalStatus,
            exitCode,
            completedAt: Date.now(),
            summary: outcome,
            ...diffFields
          }
        : d
    )
  }))

  recordMemory(companion, facility, taskPrompt, outcome)

  // Auto-advance the next queued deployment if a slot opened.
  // (Wave 4 Task 4.3 expands this; minimal version included here.)
  const after = state.getState()
  const stillActive = after.deployments.filter((d) => ACTIVE_STATUSES.includes(d.status)).length
  if (stillActive < after.settings.concurrencyCap) {
    const nextQueued = after.deployments.find((d) => d.status === 'queued')
    if (nextQueued) {
      const companion = after.companions.find((c) => c.id === nextQueued.companionId)
      const facility = after.facilities.find((f) => f.id === nextQueued.facilityId)
      if (companion && facility) {
        state.updateState((prev) => ({
          ...prev,
          deployments: prev.deployments.map((d) =>
            d.id === nextQueued.id ? { ...d, status: 'walking-to' } : d
          )
        }))
        const queuedId = nextQueued.id
        executeDeployment(queuedId, companion, facility, nextQueued.taskPrompt, opts).catch(
          (err) => {
            const message = err instanceof Error ? err.message : String(err)
            console.error(`[ipc] queued executeDeployment(${queuedId}) crashed:`, message)
            state.updateState((prev) => ({
              ...prev,
              deployments: prev.deployments.map((d) =>
                d.id === queuedId
                  ? { ...d, status: 'failed', completedAt: Date.now(), summary: message }
                  : d
              )
            }))
          }
        )
      }
    }
  }
}

/**
 * Append a deploy outcome to the companion's memory.md. Swallows errors
 * (logs only) — a memory-append failure should NEVER break an otherwise
 * successful deploy, so disk issues or path races are best-effort.
 */
function recordMemory(
  companion: Companion,
  facility: Facility,
  task: string,
  outcome: string
): void {
  try {
    appendMemoryEntry(companion.memoryPath, {
      timestamp: new Date(),
      facility: facility.name,
      task,
      outcome
    })
  } catch (err) {
    console.error(`[ipc] appendMemoryEntry(${companion.name}) failed:`, err)
  }
}
