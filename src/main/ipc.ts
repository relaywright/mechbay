import { app, ipcMain, BrowserWindow, dialog } from 'electron'
import fs from 'fs'
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
  DiffFileGetResult,
  SimpleActionResult,
  StateHealth
} from '../shared/types'
import { seedFacilities, type StateManager } from './state-manager'
import type { SecretsManager } from './secrets'
import type { Runner, SpawnResult } from './runners/types'
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
import {
  captureGitBaseline,
  computeDiffSummary,
  isGitRepository,
  readFilePatch,
  resolveInRepo
} from './git-diff'
import { redactSecrets } from './redact'
import type { MissionLogSink } from './log-store'
import type { MissionRegistry } from './mission-registry'
import { NotYetAvailableError } from '../shared/bridge-errors'
import {
  capDeployments,
  hasOpenMission,
  isOpen,
  isTerminal,
  missionsToStart
} from '../shared/mission-queue'
import { setDeployment } from './deployment-patch'
import {
  AUTONOMY_LABELS,
  AUTONOMY_LEVELS,
  DEFAULT_AUTONOMY,
  autonomyRaisedBy,
  autonomySupport,
  effectiveAutonomy
} from '../shared/autonomy'

const GRID_W = 16
const GRID_H = 16

export interface IpcDeps {
  win: BrowserWindow
  state: StateManager
  runners: Record<AgentFamily, Runner>
  fsReader: FsReader
  secrets: SecretsManager
  demoMode?: boolean
  /** Mission logs (log-store.ts). Text is redacted before it is appended. */
  logs: MissionLogSink & {
    history: (missionId: string, afterSeq?: number) => Promise<LogChunk[]>
  }
  /** Abort handles of running agents, for recall and for closing MechBay. */
  missions: MissionRegistry
}

const FS_DIR_IGNORE = ['node_modules', '.git', 'dist', 'build', '.next', '.turbo', 'out']

/**
 * Raw task text of queued deployments, by deployment id, with the secrets
 * known when it was queued. State keeps only a redacted copy for display, so
 * the exact prompt the user typed waits here, in memory and never persisted,
 * until the queue starts it. The secrets snapshot keeps a key the prompt
 * quotes redacted even if Settings replaces that key before the run.
 */
const queuedRawPrompts = new Map<string, { prompt: string; secrets: string[] }>()

/** Test seam: ids of missions whose raw prompt is still held in memory. */
export function queuedRawPromptIdsForTests(): string[] {
  return [...queuedRawPrompts.keys()]
}

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
      (deployment) => deployment.facilityId === facility.id && isOpen(deployment.status)
    )
    if (active) {
      return {
        ok: false,
        error: `${facility.name} has an active mission. Wait for it to return, or recall it first.`
      }
    }
    state.updateState((prev) => ({
      ...prev,
      facilities: prev.facilities.filter((candidate) => candidate.id !== facility.id)
    }))
    return { ok: true }
  })

  ipcMain.handle(IPC.FIELD_RESET, () => {
    if (state.getState().deployments.some((deployment) => isOpen(deployment.status))) {
      return {
        ok: false,
        error: 'Missions are still running. Wait for them to return, or recall them first.'
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
  ipcMain.handle(IPC.STATE_HEALTH_GET, (): StateHealth => state.getHealth())

  // Canonical paths of the projects the most recent scan returned. Bulk
  // import only accepts these: an imported folder joins the File Browser
  // allowlist and becomes a deploy working directory, so the renderer
  // must never be able to name an arbitrary folder. Null until a scan runs.
  let lastScanPaths: Set<string> | null = null

  // Project scanner: returns a list of discovered project directories
  // under state.settings.projectsDir (never a renderer-chosen root). The
  // renderer receives raw DiscoveredProject records and decides what to
  // do with them (picker UI, facility binding, etc.). We intentionally
  // DO NOT auto-populate facilities from scan results — how scanned
  // projects map onto the 6 seeded archetype-facilities is a design
  // decision the user needs to make. See docs/overnight-prep/
  // 2026-04-17-project-scanner-facility-binding.md for the analysis.
  ipcMain.handle(IPC.SCAN_PROJECTS, async (): Promise<DiscoveredProject[]> => {
    const s = state.getState()
    const results = await scanProjects(s.settings.projectsDir, s.settings.ignoredMarkers)
    lastScanPaths = new Set(
      results
        .map((project) => canonicalPath(project.path))
        .filter((canonical): canonical is string => canonical !== null)
    )
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
          `${facility.name} isn't linked to a project folder yet. Click the building to link it to a project folder, or use BULK IMPORT in the top bar.`
        )
      }
      if (hasOpenMission(s.deployments, companion.id)) {
        throw new Error(
          `${companion.name} is already on a mission. Wait for it to return, or recall it first.`
        )
      }

      // Every mission enters the queue; the scheduler decides when it starts.
      const secretsNow = collectSecretValues(opts)
      const deployment: Deployment = {
        id: deploymentId,
        companionId: companion.id,
        facilityId: facility.id,
        // Saved state and the UI see the redacted copy; the runner gets the raw one.
        taskPrompt: redactSecrets(args.taskPrompt, secretsNow),
        quickPromptUsed: args.quickPromptUsed,
        status: 'queued',
        startedAt: Date.now()
      }
      state.updateState((prev) => ({
        ...prev,
        deployments: capDeployments([deployment, ...prev.deployments])
      }))
      queuedRawPrompts.set(deploymentId, { prompt: args.taskPrompt, secrets: secretsNow })
      startQueuedMissions(opts)
      const status =
        state.getState().deployments.find((d) => d.id === deploymentId)?.status ?? 'queued'
      return { deploymentId, status }
    }
  )

  // The mission id comes from the renderer; the log store refuses anything
  // that is not a plain id before it touches a file.
  ipcMain.handle(IPC.LOG_HISTORY, (_e, missionId: string, afterSeq?: number) =>
    opts.logs.history(String(missionId), Number(afterSeq) || 0)
  )

  // Cancel a queued mission, or recall a running one (P0-11).
  ipcMain.handle(IPC.DEPLOY_ABORT, async (_e, missionId: string): Promise<SimpleActionResult> => {
    const mission = state.getState().deployments.find((d) => d.id === missionId)
    if (!mission) return { ok: false, error: 'Mission not found.' }
    if (isTerminal(mission.status)) return { ok: false, error: 'This mission has already ended.' }
    if (mission.status === 'queued') {
      setDeployment(state, missionId, {
        status: 'cancelled',
        completedAt: Date.now(),
        summary: 'Cancelled before it started.'
      })
      // It will never run: drop the raw prompt now.
      queuedRawPrompts.delete(missionId)
      startQueuedMissions(opts)
      return { ok: true }
    }
    // Running (walking out, working, waiting for input, returning). Mark it
    // first so the exit that follows cannot change the outcome.
    setDeployment(state, missionId, {
      status: 'cancelled',
      completedAt: Date.now(),
      summary: 'Recalled by the commander.'
    })
    // No handle yet means the agent is still starting: the launch sees the
    // cancelled status and stops it, or never starts it.
    try {
      await opts.missions.get(missionId)?.abort()
    } catch (err) {
      // Already marked cancelled; the mission's exit still ends it.
      console.error(`[ipc] abort failed for recalled mission ${missionId}:`, err)
    }
    // The mission's own exit reruns the queue too; this covers an agent that
    // outlives its time-bounded stop, so the missions behind it never stall.
    startQueuedMissions(opts)
    return { ok: true }
  })

  // Contract stubs (spec 7.5), replaced by the task that ships the feature:
  // review (Phase 1).
  ipcMain.handle(IPC.REVIEW_APPROVE, () => {
    throw new NotYetAvailableError('Reviewing changes before they are kept arrives in v1.5.')
  })
  ipcMain.handle(IPC.REVIEW_REJECT, () => {
    throw new NotYetAvailableError('Reviewing changes before they are kept arrives in v1.5.')
  })

  // Soul/Memory read/write handlers for Journal tab. Pass the SAME base
  // dir the StateManager seeded companion.soulPath/memoryPath with —
  // soul-memory's default (os.homedir()) resolves to a different tree
  // than boot scaffolding, so omitting it splits Journal reads/writes
  // from the files deployments actually inject. Only IDs of companions in
  // state are honored; soul-memory also refuses anything path-like.
  const isKnownCompanion = (companionId: unknown): boolean =>
    state.getState().companions.some((companion) => companion.id === companionId)

  ipcMain.handle(IPC.SOUL_READ, async (_e, payload: SoulReadPayload): Promise<SoulReadResult> => {
    if (!isKnownCompanion(payload?.companionId)) return { ok: false, error: 'Unknown mech.' }
    return readSoul(payload.companionId, app.getPath('userData'))
  })

  ipcMain.handle(
    IPC.SOUL_WRITE,
    async (_e, payload: SoulWritePayload): Promise<SoulWriteResult> => {
      if (!isKnownCompanion(payload?.companionId)) return { ok: false, error: 'Unknown mech.' }
      return writeSoul(payload.companionId, payload.content, app.getPath('userData'))
    }
  )

  ipcMain.handle(
    IPC.MEMORY_READ,
    async (_e, payload: MemoryReadPayload): Promise<MemoryReadResult> => {
      if (!isKnownCompanion(payload?.companionId)) return { ok: false, error: 'Unknown mech.' }
      return readMemory(payload.companionId, app.getPath('userData'))
    }
  )

  // Bulk Import handler: places multiple facilities at empty tiles. Every
  // requested path must canonicalize to a project from the latest scan,
  // otherwise the whole request is refused and state is left untouched.
  ipcMain.handle(
    IPC.BULK_IMPORT_RUN,
    async (_e, payload: BulkImportRunPayload): Promise<BulkImportRunResult> => {
      const rejected = { ok: false as const, error: 'Scan again and pick projects from the list.' }
      const requested: unknown = payload?.selectedPaths
      if (!lastScanPaths || !Array.isArray(requested)) return rejected
      const canonicalPaths: string[] = []
      for (const candidate of requested) {
        const canonical = typeof candidate === 'string' ? canonicalPath(candidate) : null
        if (!canonical || !lastScanPaths.has(canonical)) return rejected
        canonicalPaths.push(canonical)
      }

      const s = state.getState()
      const importedFacilities: Facility[] = []
      const occupied = new Set(s.facilities.map((f) => `${f.tile.x},${f.tile.y}`))
      const linked = new Set(
        s.facilities.filter((f) => f.path).map((f) => canonicalPath(f.path) ?? path.resolve(f.path))
      )

      for (const projectPath of canonicalPaths) {
        // Already a facility (or listed twice in this request): skip it.
        if (linked.has(projectPath)) continue
        linked.add(projectPath)

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
      const autonomy = payload.autonomy
      if (autonomy !== undefined && !AUTONOMY_LEVELS.includes(autonomy)) {
        return { ok: false, error: `Unknown Autonomy level: ${String(autonomy)}` }
      }
      if (runtime !== undefined && !Object.hasOwn(runners, runtime)) {
        return { ok: false, error: `Unknown runtime: ${runtime}` }
      }
      const savedRuntime = companion.runtime ?? companion.family
      const savedLevel = companion.autonomy ?? DEFAULT_AUTONOMY
      const targetRuntime = runtime ?? savedRuntime
      if (runtime !== undefined && autonomy === undefined) {
        // A runtime switch must never quietly give a mech more than it has
        // today: Read only on Claude would run at Full on Gemini.
        const raised = autonomyRaisedBy(savedRuntime, runtime, savedLevel)
        if (raised !== undefined && payload.acceptAutonomy !== raised) {
          const label = raised === 'unenforced' ? 'Not enforced' : AUTONOMY_LABELS[raised]
          return {
            ok: false,
            error: `This runtime would raise the mech's Autonomy to ${label}. Confirm the switch to continue.`
          }
        }
      }
      if (autonomy !== undefined) {
        const support = autonomySupport(targetRuntime)
        if (!support.available[autonomy]) {
          return {
            ok: false,
            error:
              `${AUTONOMY_LABELS[autonomy]} is not available for this runtime. ${support.reason ?? ''}`.trim()
          }
        }
      }

      let cliAvailable = companion.cliAvailable
      if (runtime !== undefined) {
        try {
          cliAvailable = await runners[runtime].isAvailable()
        } catch (err) {
          console.warn(`[ipc] isAvailable() threw for runtime ${runtime}:`, err)
          cliAvailable = false
        }
        // The checks above were made against the settings before the await;
        // if another change landed meanwhile, they no longer hold.
        const now = state.getState().companions.find((c) => c.id === companionId)
        if (
          (now?.runtime ?? now?.family) !== savedRuntime ||
          (now?.autonomy ?? DEFAULT_AUTONOMY) !== savedLevel
        ) {
          return { ok: false, error: 'Settings changed while saving. Try again.' }
        }
      }

      state.updateState((prev) => ({
        ...prev,
        companions: prev.companions.map((c) =>
          c.id === companionId
            ? {
                ...c,
                ...(name ? { name } : {}),
                ...(autonomy ? { autonomy } : {}),
                ...(runtime !== undefined
                  ? { runtime, model: payload.model?.trim() || undefined, cliAvailable }
                  : {})
              }
            : c
        )
      }))
      return { ok: true, cliAvailable }
    }
  )
}

/**
 * Start queued missions while there are free slots (P0-10): oldest first,
 * one per mech, up to the concurrency cap. Runs after every new mission
 * and after every mission ends, however it ends.
 */
export function startQueuedMissions(opts: IpcDeps): void {
  const { state } = opts
  // A raw prompt is kept only while its mission waits. Anything that ended a
  // queued mission elsewhere (the boot sweep, for one) leaves an entry that
  // no mission will ever read: drop it here.
  const waiting = new Set(
    state
      .getState()
      .deployments.filter((d) => d.status === 'queued')
      .map((d) => d.id)
  )
  for (const id of queuedRawPrompts.keys()) {
    if (!waiting.has(id)) queuedRawPrompts.delete(id)
  }

  for (;;) {
    const next = missionsToStart(state.getState())[0]
    if (!next) return
    const s = state.getState()
    const companion = s.companions.find((c) => c.id === next.companionId)
    const facility = s.facilities.find((f) => f.id === next.facilityId)
    // Read and forget the raw prompt: from here the mission either runs or ends.
    const entry = queuedRawPrompts.get(next.id)
    queuedRawPrompts.delete(next.id)
    if (!companion || !facility || !facility.path) {
      const summary = !companion
        ? 'This mech no longer exists.'
        : !facility
          ? 'This building was removed before the mission started.'
          : `${facility.name} is no longer linked to a project folder.`
      setDeployment(state, next.id, { status: 'failed', completedAt: Date.now(), summary })
      continue
    }
    setDeployment(state, next.id, { status: 'walking-to' })
    // After a restart the raw text is gone; the stored copy differs from it
    // only where a key was redacted.
    launchMission(
      next.id,
      companion,
      facility,
      entry?.prompt ?? next.taskPrompt,
      opts,
      entry?.secrets
    )
  }
}

function launchMission(
  id: string,
  companion: Companion,
  facility: Facility,
  taskPrompt: string,
  opts: IpcDeps,
  queuedSecrets: readonly string[] = []
): void {
  // Fire and forget: execution updates state asynchronously. A crash lands
  // in the mission as 'failed', and the queue moves on either way.
  executeDeployment(id, companion, facility, taskPrompt, opts, queuedSecrets)
    .catch((err) => {
      const message = redactSecrets(err instanceof Error ? err.message : String(err), [
        ...collectSecretValues(opts),
        ...queuedSecrets
      ])
      console.error(`[ipc] executeDeployment(${id}) crashed:`, message)
      setDeployment(opts.state, id, { status: 'failed', completedAt: Date.now(), summary: message })
    })
    .finally(() => {
      try {
        startQueuedMissions(opts)
      } catch (err) {
        console.error('[ipc] startQueuedMissions failed after a mission ended:', err)
      }
    })
}

export async function executeDeployment(
  deploymentId: string,
  companion: Companion,
  facility: Facility,
  taskPrompt: string,
  opts: IpcDeps,
  /** Secrets known when a queued task was entered, redacted alongside today's. */
  extraSecrets: readonly string[] = []
): Promise<void> {
  try {
    await runDeployment(deploymentId, companion, facility, taskPrompt, opts, extraSecrets)
  } finally {
    // Every exit path, including a crash: forget the abort handle, write the
    // last lines and free the buffer.
    opts.missions.delete(deploymentId)
    opts.logs.close(deploymentId)
  }
}

async function runDeployment(
  deploymentId: string,
  companion: Companion,
  facility: Facility,
  taskPrompt: string,
  opts: IpcDeps,
  extraSecrets: readonly string[]
): Promise<void> {
  const { state, runners } = opts
  const effectiveRuntime = companion.runtime ?? companion.family
  const runner = runners[effectiveRuntime]
  if (!runner) {
    setDeployment(state, deploymentId, {
      status: 'failed',
      completedAt: Date.now(),
      summary: `No runner registered for runtime: ${effectiveRuntime}`
    })
    return
  }

  // Every API key this run could see, so each log chunk and the failure
  // summary can be scrubbed before it is shown or saved. Starts with the
  // stored and environment keys (enough for a failure before launch) and
  // gains the launch environment's secrets once that snapshot is taken.
  let secretValues = [...collectSecretValues(opts), ...extraSecrets]
  const redact = (text: string): string => redactSecrets(text, secretValues)

  // The level this mission actually runs at; null when the runtime
  // controls its own permissions and MechBay cannot limit it.
  const level = effectiveAutonomy(effectiveRuntime, companion.autonomy ?? DEFAULT_AUTONOMY)

  // A recalled mission is 'cancelled' (P0-11). Checked after the waits
  // before and during launch, since a recall can land during any of them.
  const isCancelled = (): boolean =>
    state.getState().deployments.find((d) => d.id === deploymentId)?.status === 'cancelled'

  // Transition to working
  setDeployment(state, deploymentId, { status: 'working', autonomy: level ?? 'unenforced' })

  let exitCode: number
  let denials: string[] = []
  let baselineSha: string | null = null
  // Outside the try, so a failure while reading the agent's output can stop it.
  let result: SpawnResult | undefined
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
    if (baselineSha) setDeployment(state, deploymentId, { baselineSha })

    // One snapshot of the launch environment: the same object the child
    // gets is the one its secrets are redacted from, so a key changed in
    // Settings mid-launch can't slip past the redactor.
    const launchEnv = opts.secrets.envFor(effectiveRuntime)
    secretValues = [...secretValues, ...secretEnvValues(launchEnv)]
    // Immediately before the launch, after every wait above it: a recall
    // that landed during any of them means the agent never starts.
    if (isCancelled()) {
      // Recalled while the mech was still walking out: never start the agent.
      recordMemory(
        companion,
        facility,
        taskPrompt,
        'Recalled by the commander before it started.',
        secretValues
      )
      return
    }
    result = await runner.spawn(facility.path, fullPrompt, {
      model: companion.model,
      env: launchEnv,
      autonomy: level ?? undefined
    })
    const started = result
    opts.missions.set(deploymentId, { abort: () => started.abort() })
    // Recalled while the agent was starting: stop it now that it exists.
    if (isCancelled()) {
      void started.abort().catch((err) => {
        console.error(`[ipc] abort failed for recalled mission ${deploymentId}:`, err)
      })
    }
    const parser = new NarrationParser()

    const emit = (p: {
      stream: LogChunk['stream']
      text: string
      thoughtKind?: 'intent' | 'findings'
    }): void => {
      // Redact here, before the line reaches the log store: the store sends
      // it to the window and writes it to disk exactly as given.
      opts.logs.append(deploymentId, { ...p, text: redact(p.text) })
    }

    // Drain stream BEFORE awaiting exit — exit may resolve while chunks
    // are still queued. Sequential await guarantees all chunks reach renderer.
    for await (const chunk of result.stream) {
      for (const parsed of parser.feed(chunk)) emit(parsed)
    }
    // Flush any partial trailing line left in the parser buffers.
    for (const parsed of parser.flush()) emit(parsed)

    exitCode = await result.exit
    // Denial labels carry raw command text (for example `Bash: <command>`),
    // which can hold an API key: redact them like every log line before
    // they are saved and sent to the window.
    denials = (result.report?.().permissionDenials ?? []).map(redact)
  } catch (err) {
    // The agent may still be running (its output stream failed, not the
    // agent): stop it before the mission ends and its slot is reused.
    await result?.abort().catch((abortErr) => {
      console.error(`[ipc] abort failed for mission ${deploymentId}:`, abortErr)
    })
    const message = redact(err instanceof Error ? err.message : String(err))
    // A recalled mission stays cancelled: setDeployment keeps its outcome.
    setDeployment(state, deploymentId, {
      status: 'failed',
      completedAt: Date.now(),
      summary: message
    })
    recordMemory(
      companion,
      facility,
      taskPrompt,
      isCancelled() ? 'Recalled by the commander.' : `Failed before exit. ${message}`,
      secretValues
    )
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
  // A null diff means "no repository" only when there is truly none: a
  // captured baseline, a repo without commits, or a .git that git could not
  // read means git refused or failed.
  const gitUnreadable =
    exitCode === 0 &&
    diff === null &&
    (baselineSha !== null || (await isGitRepository(facility.path)) !== 'none')
  const diffNote =
    diff === null
      ? ''
      : diff.filesChanged === 0
        ? 'No file changes detected.'
        : `${diff.filesChanged} file${diff.filesChanged === 1 ? '' : 's'} changed, +${diff.insertions} −${diff.deletions}.`
  const outcome =
    exitCode === 0
      ? diff === null
        ? gitUnreadable
          ? 'Completed. The diff is unavailable because git could not read this project.'
          : 'Completed. (No git repository, so no diff is available.)'
        : `Completed. ${diffNote}`
      : `Failed. Exit ${exitCode}.`
  // For a recalled mission this only merges the diff and denials: its
  // status, summary and exit code became final when it was recalled.
  setDeployment(state, deploymentId, {
    status: finalStatus,
    exitCode,
    completedAt: Date.now(),
    summary: outcome,
    ...diffFields,
    ...(denials.length ? { permissionDenials: denials } : {})
  })

  recordMemory(
    companion,
    facility,
    taskPrompt,
    isCancelled() ? `Recalled by the commander. ${diffNote}`.trim() : outcome,
    secretValues
  )
}

/**
 * The real, canonical spelling of an existing path (symlinks resolved,
 * trailing separators dropped, true letter case on Windows), or null when
 * it does not exist or cannot be read.
 */
function canonicalPath(target: string): string | null {
  try {
    return fs.realpathSync.native(target)
  } catch {
    return null
  }
}

/**
 * API-key environment variables the runtimes read: the ones SecretsManager
 * injects (secrets.ts ENV_BY_RUNTIME) plus ANTHROPIC_API_KEY, which the
 * Claude CLI picks up from MechBay's own environment.
 */
const API_KEY_ENV_VARS = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GEMINI_API_KEY',
  'FIREWORKS_API_KEY',
  'MECHBAY_HERMES_API_KEY'
]

/** An environment variable whose name says its value is a credential. */
const SECRET_ENV_NAME = /KEY|TOKEN|SECRET|PASSWORD/i

/** Values of the variables in `env` whose name looks secret. */
function secretEnvValues(env: Record<string, string | undefined>): string[] {
  return Object.entries(env)
    .filter(([name]) => SECRET_ENV_NAME.test(name))
    .map(([, value]) => value)
    .filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Stored keys for every runtime, the runtime API key variables, and every
 * inherited environment variable whose name looks secret (an agent that
 * prints its environment would otherwise show, say, GITHUB_TOKEN).
 */
export function collectSecretValues(opts: Pick<IpcDeps, 'runners' | 'secrets'>): string[] {
  const families = Object.keys(opts.runners) as AgentFamily[]
  return [
    ...families.map((family) => opts.secrets.getSecret(family)),
    ...API_KEY_ENV_VARS.map((name) => process.env[name]),
    ...secretEnvValues(process.env)
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)
}

/**
 * Append a deploy outcome to the companion's memory.md, with every secret
 * redacted from the task and the outcome (memory is shown in the Journal and
 * fed into future prompts). Swallows errors (logs only): a memory-append
 * failure should NEVER break an otherwise successful deploy, so disk issues
 * or path races are best-effort.
 */
function recordMemory(
  companion: Companion,
  facility: Facility,
  task: string,
  outcome: string,
  secrets: readonly string[]
): void {
  try {
    appendMemoryEntry(companion.memoryPath, {
      timestamp: new Date(),
      facility: facility.name,
      task: redactSecrets(task, secrets),
      outcome: redactSecrets(outcome, secrets)
    })
  } catch (err) {
    console.error(`[ipc] appendMemoryEntry(${companion.name}) failed:`, err)
  }
}
