import { EventEmitter } from 'events'
import { copyFileSync, constants as fsConstants } from 'fs'
import path from 'path'
import os from 'os'
import type {
  AgentFamily,
  AppState,
  Companion,
  Deployment,
  Facility,
  FacilityType,
  MechClass,
  StateHealth
} from '../shared/types'
import { ulid } from '../shared/ulid'
import { DEFAULT_AUTONOMY } from '../shared/autonomy'
import { isActive } from '../shared/mission-queue'
import {
  CURRENT_SCHEMA_VERSION,
  isAppStateV2,
  migrateState,
  type LogChunkV2,
  type MigrationTable
} from './state-migrations'

const GRID_W = 16
const GRID_H = 16

interface MechSeed {
  family: AgentFamily
  mechClass: MechClass
  name: string
  homeTile: { x: number; y: number }
}

const DEFAULT_MECH_MAP: MechSeed[] = [
  { family: 'claude', mechClass: 'atlas', name: 'Atlas-Prime', homeTile: { x: 4, y: 10 } },
  { family: 'codex', mechClass: 'marauder', name: 'Marauder-Prime', homeTile: { x: 6, y: 10 } },
  { family: 'kimi', mechClass: 'raven', name: 'Raven-Prime', homeTile: { x: 8, y: 10 } },
  { family: 'gemini', mechClass: 'catapult', name: 'Catapult-Prime', homeTile: { x: 10, y: 10 } },
  { family: 'hermes', mechClass: 'locust', name: 'Locust-Prime', homeTile: { x: 12, y: 10 } }
]

interface FacilitySeed {
  facilityType: FacilityType
  name: string
  tile: { x: number; y: number }
}

export const DEFAULT_FACILITY_MAP: FacilitySeed[] = [
  { facilityType: 'security-bay', name: 'Security Bay', tile: { x: 3, y: 3 } },
  { facilityType: 'research-lab', name: 'Research Lab', tile: { x: 8, y: 3 } },
  { facilityType: 'foundry', name: 'Foundry', tile: { x: 13, y: 3 } },
  { facilityType: 'salvage-dock', name: 'Salvage Dock', tile: { x: 3, y: 13 } },
  { facilityType: 'command-center', name: 'Command Center', tile: { x: 8, y: 6 } },
  { facilityType: 'data-archive', name: 'Data Archive', tile: { x: 13, y: 13 } }
]

export function seedFacilities(): Facility[] {
  return DEFAULT_FACILITY_MAP.map((facility) => ({
    id: ulid(),
    facilityType: facility.facilityType,
    name: facility.name,
    tile: facility.tile,
    path: '',
    source: 'manual',
    discoveredAt: Date.now()
  }))
}

function defaultState(userDataDir: string): AppState {
  return {
    version: CURRENT_SCHEMA_VERSION,
    companions: DEFAULT_MECH_MAP.map((m) => {
      const id = ulid()
      const barracks = path.join(userDataDir, 'mechbay', 'companions', id)
      const companion: Companion = {
        id,
        family: m.family,
        mechClass: m.mechClass,
        name: m.name,
        spriteKey: `mech-${m.mechClass}`,
        homeTile: m.homeTile,
        cliAvailable: false,
        soulPath: path.join(barracks, 'soul.md'),
        memoryPath: path.join(barracks, 'memory.md'),
        autonomy: DEFAULT_AUTONOMY
      }
      return companion
    }),
    // Seed facilities are unlinked until the user binds a project directory.
    facilities: seedFacilities(),
    deployments: [],
    settings: {
      projectsDir: path.join(os.homedir(), 'Projects'),
      concurrencyCap: 3,
      ignoredMarkers: [
        'node_modules',
        'dist',
        'build',
        '.next',
        '__pycache__',
        'Archived Projects DO NOT SCAN'
      ],
      reduceMotion: false
    }
  }
}

export interface StoreLike {
  get: (k: string) => unknown
  set: (k: string, v: unknown) => void
  has: (k: string) => boolean
  /** Absolute path of the backing file. electron-store provides it; in-memory test stores omit it. */
  readonly path?: string
}

export interface StateManagerOptions {
  /** Set when opening the store already had to move a damaged file aside (state-store.ts). */
  startupNotice?: string
  /** Test seam: replace the migration table, for example with one that throws. */
  migrations?: MigrationTable
  /** Test seam: replace the backup copy. Must refuse to overwrite an existing file. */
  copyFile?: (from: string, to: string) => void
}

/** `mechbay-state.json` becomes `mechbay-state.<label>-backup-<ISO time with : and . as ->.json`. */
export function backupPathFor(statePath: string, label: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-')
  const ext = path.extname(statePath) || '.json'
  const base = statePath.slice(0, statePath.length - path.extname(statePath).length)
  return `${base}.${label}-backup-${stamp}${ext}`
}

function errorText(err: unknown): string {
  if (err instanceof Error) return (err as NodeJS.ErrnoException).code ?? err.message
  return String(err)
}

export function repairFacilityTileCollisions(state: AppState): {
  state: AppState
  changed: boolean
} {
  const seen = new Set<string>()
  let changed = false
  const facilities = state.facilities.map((facility) => {
    const key = `${facility.tile.x},${facility.tile.y}`
    if (!seen.has(key)) {
      seen.add(key)
      return facility
    }

    let freeTile: { x: number; y: number } | undefined
    for (let y = 0; y < GRID_H && !freeTile; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (!seen.has(`${x},${y}`)) {
          freeTile = { x, y }
          break
        }
      }
    }
    if (!freeTile) return facility

    changed = true
    seen.add(`${freeTile.x},${freeTile.y}`)
    return { ...facility, tile: freeTile }
  })

  return changed ? { state: { ...state, facilities }, changed } : { state, changed }
}

/**
 * StateManager — centralized application state with persistence.
 *
 * ## Events
 *
 * The StateManager extends EventEmitter and emits the following events:
 *
 * ### `stateChanged` → `(state: AppState) => void`
 * Emitted whenever the state is successfully updated. The payload is the
 * new complete AppState. Listeners should treat this as the source of truth.
 *
 * ### `statePersistFailed` → `(state: AppState, err: unknown) => void`
 * Emitted when a state update succeeds in memory but fails to persist to
 * the underlying store. The state parameter is the updated (but not persisted)
 * state; err is the underlying error from the store implementation.
 *
 * @example
 * ```ts
 * stateManager.on('stateChanged', handleStateUpdate)
 * stateManager.on('statePersistFailed', handlePersistFailure)
 * ```
 *
 * Loading goes through state-migrations.ts; a save it cannot safely upgrade
 * makes the session read-only (see getHealth).
 */
export class StateManager extends EventEmitter {
  private store: StoreLike
  private cache: AppState
  private readOnly = false
  private health: StateHealth = { ok: true }
  private legacyLogChunks: LogChunkV2[] = []
  private freshBay = false

  constructor(
    store: StoreLike,
    userDataDir: string = os.homedir(),
    options: StateManagerOptions = {}
  ) {
    super()
    this.store = store
    this.cache = defaultState(userDataDir)
    const copyFile =
      options.copyFile ??
      ((from: string, to: string) => copyFileSync(from, to, fsConstants.COPYFILE_EXCL))
    const notices = options.startupNotice ? [options.startupNotice] : []

    let raw: unknown
    let hasExisting: boolean
    try {
      hasExisting = store.has('state')
      raw = hasExisting ? store.get('state') : undefined
    } catch (err) {
      // The file is there but could not be read (another program holds it,
      // permissions). Writing now could destroy a good save.
      this.refuse(
        'read-failed',
        `MechBay could not read your saved bay (${errorText(err)}). Nothing was changed. Anything you do in this session will not be saved. Close any program that may be using the file, then restart MechBay.`
      )
      return
    }

    if (!hasExisting) {
      this.freshBay = true
      this.persist(this.cache)
      this.health = notices.length ? { ok: true, notice: notices.join(' ') } : { ok: true }
      return
    }

    const outcome = migrateState(raw, options.migrations)
    switch (outcome.kind) {
      case 'current': {
        // Schema 3 saves written by Track B development builds before logs
        // moved out still carry logChunks: hand them to the log store and
        // drop them from saved state, as the v2 upgrade does.
        // Back the file up first, as the v2 upgrade does: the lines leave
        // saved state before the log store has written them. Without a
        // backup the save is left as it is (stale lines kept, nothing lost).
        const { logChunks, ...current } = outcome.state as AppState & { logChunks?: unknown }
        if (Array.isArray(logChunks) && this.backup('v3-logs', copyFile).ok) {
          this.legacyLogChunks = logChunks as LogChunkV2[]
          this.cache = this.repairAndPersist(current, true)
        } else {
          this.cache = this.repairAndPersist(outcome.state, false)
        }
        break
      }
      case 'migrated': {
        const backup = this.backup(`v${outcome.from}`, copyFile)
        if (!backup.ok) {
          this.refuse(
            'migration-failed',
            `MechBay could not back up your saved bay before upgrading it (${backup.error}), so it left the file untouched. Anything you do in this session will not be saved. Check that the disk has free space and that MechBay can write to the folder of the file shown below, then restart MechBay.`
          )
          return
        }
        console.info(
          `[state-manager] Upgraded saved bay from schema ${outcome.from} to ${CURRENT_SCHEMA_VERSION}${backup.path ? `; backup at ${backup.path}` : ''}`
        )
        if (isAppStateV2(raw)) this.legacyLogChunks = raw.logChunks
        this.cache = this.repairAndPersist(outcome.state, true)
        break
      }
      case 'newer':
        this.refuse(
          'newer-version',
          `This saved bay was written by a newer version of MechBay (schema ${outcome.found}; this version reads up to ${CURRENT_SCHEMA_VERSION}). MechBay left the file untouched. Anything you do in this session will not be saved. Update MechBay to keep using this bay.`
        )
        return
      case 'failed':
        this.refuse(
          'migration-failed',
          `MechBay could not upgrade your saved bay from schema ${outcome.from} (${outcome.error}). The file is untouched. Anything you do in this session will not be saved. Please report this at github.com/samalbanese/mechbay/issues.`
        )
        return
      case 'unreadable': {
        const backup = this.backup('unreadable', copyFile)
        if (!backup.ok) {
          this.refuse(
            'read-failed',
            `Your saved bay could not be read (${outcome.reason}) and MechBay could not keep a copy of it (${backup.error}), so it left the file untouched. Anything you do in this session will not be saved.`
          )
          return
        }
        console.warn(`[state-manager] Saved bay unreadable (${outcome.reason}); starting fresh`)
        this.freshBay = true
        this.persist(this.cache)
        notices.push(
          backup.path
            ? `Your saved bay could not be read (${outcome.reason}), so MechBay started a fresh one. The old file was kept at ${backup.path}.`
            : `Your saved bay could not be read (${outcome.reason}), so MechBay started a fresh one.`
        )
        break
      }
    }
    this.health = notices.length ? { ok: true, notice: notices.join(' ') } : { ok: true }
  }

  /**
   * True when this session began with a brand-new bay: there was no saved
   * file (including one set aside as damaged) or it could not be read.
   */
  startedFresh(): boolean {
    return this.freshBay
  }

  /** Schema 2 kept logs inside saved state. Returns them once for the log store to import. */
  takeLegacyLogChunks(): LogChunkV2[] {
    const chunks = this.legacyLogChunks
    this.legacyLogChunks = []
    return chunks
  }

  /** How the saved bay loaded. Not ok means this session never writes the saved file. */
  getHealth(): StateHealth {
    return this.health
  }

  private refuse(reason: Extract<StateHealth, { ok: false }>['reason'], message: string): void {
    this.readOnly = true
    this.health = {
      ok: false,
      reason,
      message,
      ...(this.store.path ? { statePath: this.store.path } : {})
    }
    console.error(`[state-manager] Saved bay is read-only this session: ${message}`)
  }

  private backup(
    label: string,
    copyFile: (from: string, to: string) => void
  ): { ok: true; path?: string } | { ok: false; error: string } {
    const source = this.store.path
    if (!source) return { ok: true } // in-memory store: nothing on disk to keep
    const target = backupPathFor(source, label)
    try {
      copyFile(source, target)
      return { ok: true, path: target }
    } catch (err) {
      return { ok: false, error: errorText(err) }
    }
  }

  private repairAndPersist(state: AppState, force: boolean): AppState {
    const repaired = repairFacilityTileCollisions(state)
    if (repaired.changed || force) this.persist(repaired.state)
    return repaired.state
  }

  private persist(state: AppState): void {
    if (this.readOnly) return
    try {
      this.store.set('state', state)
    } catch (err) {
      console.error('[state-manager] Store write failed:', err)
    }
  }

  getState(): AppState {
    return this.cache
  }

  updateState(updater: (s: AppState) => AppState): AppState {
    this.cache = updater(this.cache)
    this.emit('stateChanged', this.cache)
    // Read-only: the saved file belongs to a newer MechBay or could not be
    // upgraded or read. Never overwrite it.
    if (this.readOnly) return this.cache
    try {
      this.store.set('state', this.cache)
    } catch (err) {
      console.error('[state-manager] Store write failed:', err)
      this.emit('statePersistFailed', this.cache, err)
    }
    return this.cache
  }

  /**
   * After a crash or a hard quit: missions that were running are marked
   * failed; missions still waiting are cancelled rather than started
   * unattended. Returns the changed missions for the recovery dialog.
   *
   * Idempotent: calling on a freshly-seeded or already-swept state
   * returns an empty array and leaves state untouched.
   */
  sweepZombieDeployments(): Deployment[] {
    const now = Date.now()
    const changed: Deployment[] = []
    for (const d of this.cache.deployments) {
      if (isActive(d.status)) {
        changed.push({
          ...d,
          status: 'failed',
          summary: 'Interrupted when MechBay closed unexpectedly.',
          completedAt: now
        })
      } else if (d.status === 'queued') {
        changed.push({
          ...d,
          status: 'cancelled',
          summary: 'Cancelled: MechBay closed before it started.',
          completedAt: now
        })
      }
    }
    if (changed.length === 0) return []
    const byId = new Map(changed.map((d) => [d.id, d]))
    this.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => byId.get(d.id) ?? d)
    }))
    return changed
  }
}
