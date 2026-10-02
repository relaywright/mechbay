import type { AgentFamily, AppState, DiffFileStat, FacilityType, MechClass } from '../shared/types'
import { DEFAULT_AUTONOMY } from '../shared/autonomy'

/**
 * Saved-state migrations (P0-14). The saved bay is upgraded one schema
 * version at a time, never wiped. To add schema N + 1:
 * 1. Freeze the shape that release saved: copy its AppState into an
 *    `AppStateVn` type below (from `git show <tag>:src/shared/types.ts`)
 *    and never edit it again.
 * 2. Add `MIGRATIONS[n]`, a pure function from schema n to n + 1, and a
 *    `SAVED_SHAPES[n]` check.
 * 3. Add a fixture saved by that release under test/fixtures/state/.
 * A migration never drops user content (facilities, deployments,
 * companions, settings values). Dropping a field nothing wrote is fine.
 */

export const CURRENT_SCHEMA_VERSION = 3
/** v1.4.0, the first public release, saved schema 2. Schema 1 never shipped. */
export const MIN_MIGRATABLE_VERSION = 2

// Frozen: the AppState that v1.4.0 saved (schema 2). Do not edit.
export interface CompanionV2 {
  id: string
  family: AgentFamily
  mechClass: MechClass
  name: string
  spriteKey: string
  homeTile: { x: number; y: number }
  cliAvailable: boolean
  recentDeploymentIds: string[]
  soulPath: string
  memoryPath: string
  lastMemoryUpdateAt?: number
  runtime?: AgentFamily
  model?: string
}

export interface FacilityV2 {
  id: string
  name: string
  path: string
  facilityType: FacilityType
  tile: { x: number; y: number }
  source: 'auto-scan' | 'manual'
  discoveredAt: number
  decommissioned?: boolean
}

export interface DeploymentV2 {
  id: string
  companionId: string
  facilityId: string
  taskPrompt: string
  quickPromptUsed?: string
  status:
    | 'queued'
    | 'walking-to'
    | 'working'
    | 'awaiting-input'
    | 'returning'
    | 'completed'
    | 'failed'
    | 'cancelled'
  startedAt: number
  completedAt?: number
  exitCode?: number
  summary?: string
  diffStats?: { filesChanged: number; insertions: number; deletions: number }
  diffFiles?: DiffFileStat[]
  baselineSha?: string
  pendingInput?: { prompt: string; detectedAt: number }
}

export interface LogChunkV2 {
  id: string
  deploymentId: string
  timestamp: number
  stream: 'stdout' | 'stderr' | 'system' | 'thought'
  text: string
  thoughtKind?: 'intent' | 'findings'
}

export interface AppStateV2 {
  version: 2
  companions: CompanionV2[]
  facilities: FacilityV2[]
  deployments: DeploymentV2[]
  logChunks: LogChunkV2[]
  settings: {
    projectsDir: string
    concurrencyCap: number
    ignoredMarkers: string[]
    companionNameOverrides: Record<string, string>
    reduceMotion?: boolean
    crtOverlay?: boolean
    missionAlerts?: boolean
  }
  lastScanAt?: number
}

export type Migration = (state: unknown) => unknown
export type MigrationTable = Readonly<Record<number, Migration>>

export type MigrationOutcome =
  | { kind: 'current'; state: AppState }
  | { kind: 'migrated'; from: number; state: AppState }
  | { kind: 'newer'; found: number }
  | { kind: 'failed'; from: number; error: string }
  | { kind: 'unreadable'; reason: string }

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function hasCoreShape(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    Array.isArray(value.companions) &&
    Array.isArray(value.facilities) &&
    Array.isArray(value.deployments) &&
    isRecord(value.settings)
  )
}

export function isAppStateV2(value: unknown): value is AppStateV2 {
  return hasCoreShape(value) && value.version === 2 && Array.isArray(value.logChunks)
}

export function isValidCurrentState(value: unknown): value is AppState {
  return hasCoreShape(value) && value.version === CURRENT_SCHEMA_VERSION
}

/** Shape checks for every schema a release saved, so a damaged file is told apart from a migration bug. */
const SAVED_SHAPES: Readonly<Record<number, (value: unknown) => boolean>> = {
  2: isAppStateV2
}

/**
 * Schema 2 to 3: drop five fields no player sees or edits. v1.4.0 wrote
 * `lastScanAt` (a timestamp nothing displayed), seeded empty
 * `recentDeploymentIds` and `companionNameOverrides`, and read
 * `pendingInput`; none of them carries anything a player made.
 * `logChunks` also leaves saved state, but its lines are not lost:
 * StateManager hands them to the log store (log-store.ts), which writes
 * them to per-mission files at startup. Every mech gains the default
 * Autonomy level (P0-12, DEFAULT_AUTONOMY: Edit files).
 */
export function migrateV2ToV3(input: unknown): AppState {
  const s = input as AppStateV2
  const { lastScanAt: _lastScanAt, logChunks: _logChunks, settings, ...rest } = s
  const { companionNameOverrides: _overrides, ...keptSettings } = settings
  return {
    ...rest,
    version: 3,
    companions: s.companions.map(({ recentDeploymentIds: _ids, ...companion }) => ({
      ...companion,
      autonomy: DEFAULT_AUTONOMY
    })),
    facilities: s.facilities.map(({ decommissioned: _decommissioned, ...facility }) => facility),
    deployments: s.deployments.map(({ pendingInput: _pending, ...deployment }) => deployment),
    settings: keptSettings
  }
}

export const MIGRATIONS: MigrationTable = { 2: migrateV2ToV3 }

/**
 * Schema versions are whole numbers. 2.5, NaN or Infinity is a damaged
 * value, not a newer MechBay; so is an integer too large to compare
 * exactly.
 */
function readVersion(raw: unknown): number | null {
  return isRecord(raw) && Number.isSafeInteger(raw.version) ? (raw.version as number) : null
}

/**
 * Bring a saved state up to the current schema. Never mutates `raw`.
 * - current: already up to date and well formed.
 * - migrated: upgraded; the caller backs up the old file, then saves.
 * - newer: written by a newer MechBay; the caller must not overwrite it.
 * - failed: a well-formed old save that a migration could not upgrade
 *   (a MechBay bug); the caller leaves the file untouched.
 * - unreadable: not something any release saved (damaged, hand-edited,
 *   or pre-release schema 1).
 */
export function migrateState(
  raw: unknown,
  migrations: MigrationTable = MIGRATIONS
): MigrationOutcome {
  const version = readVersion(raw)
  if (version === null) return { kind: 'unreadable', reason: 'it has no schema version' }
  if (version > CURRENT_SCHEMA_VERSION) return { kind: 'newer', found: version }
  if (version === CURRENT_SCHEMA_VERSION) {
    return isValidCurrentState(raw)
      ? { kind: 'current', state: raw }
      : { kind: 'unreadable', reason: 'it is missing required fields' }
  }
  if (version < MIN_MIGRATABLE_VERSION) {
    return { kind: 'unreadable', reason: `schema ${version} predates the first public release` }
  }
  if (!SAVED_SHAPES[version]?.(raw)) {
    return { kind: 'unreadable', reason: `it does not match the schema ${version} layout` }
  }

  let working: unknown = structuredClone(raw)
  try {
    for (let v = version; v < CURRENT_SCHEMA_VERSION; v++) {
      const step = migrations[v]
      if (!step) throw new Error(`no migration from schema ${v}`)
      working = step(working)
    }
  } catch (err) {
    return {
      kind: 'failed',
      from: version,
      error: err instanceof Error ? err.message : String(err)
    }
  }
  return isValidCurrentState(working)
    ? { kind: 'migrated', from: version, state: working }
    : { kind: 'failed', from: version, error: 'the upgraded state did not validate' }
}
