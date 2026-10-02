/**
 * Shared type definitions for MechBay.
 *
 * These types are imported by Main, Preload, and Renderer. Keep them
 * serializable (no class instances, no functions, no Maps/Sets) so they
 * cross IPC boundaries cleanly.
 */

export type AgentFamily = 'claude' | 'codex' | 'kimi' | 'gemini' | 'hermes'

export interface AppMode {
  demo: boolean
}

export type MechClass = 'atlas' | 'marauder' | 'raven' | 'catapult' | 'locust'

export type FacilityType =
  'security-bay' | 'research-lab' | 'foundry' | 'command-center' | 'salvage-dock' | 'data-archive'

/** Filesystem tree node returned by FS_READ_DIR — consumed by FileBrowser. */
export interface FsNode {
  name: string
  path: string
  type: 'file' | 'directory'
  size?: number
}

export type DeploymentStatus =
  | 'queued'
  | 'walking-to'
  | 'working'
  | 'awaiting-input'
  | 'returning'
  | 'completed'
  | 'failed'
  | 'cancelled'

export interface Companion {
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
  /**
   * Runtime override — which agent family this companion actually
   * deploys with. Undefined means "use `family`". Optional so old
   * persisted state (pre-runtime-reassignment) stays valid without a
   * schema bump.
   */
  runtime?: AgentFamily
  /** Optional model override passed through to the runtime CLI. */
  model?: string
}

export interface Facility {
  id: string
  name: string
  path: string
  facilityType: FacilityType
  tile: { x: number; y: number }
  source: 'auto-scan' | 'manual'
  discoveredAt: number
  decommissioned?: boolean
}

export interface DiffFileStat {
  path: string
  insertions: number
  deletions: number
}

/** One line inside a diff hunk. `oldNo`/`newNo` are omitted for lines that don't exist on that side. */
export interface DiffLine {
  kind: 'add' | 'del' | 'ctx'
  text: string
  oldNo?: number
  newNo?: number
}

export interface DiffHunk {
  header: string
  lines: DiffLine[]
}

/** Per-file patch returned by DIFF_FILE_GET, rendered by DiffViewer. */
export interface FilePatch {
  path: string
  binary: boolean
  truncated: boolean
  hunks: DiffHunk[]
}

/** Payload for DIFF_FILE_GET IPC call. */
export interface DiffFileGetPayload {
  deploymentId: string
  path: string
}

/** Result for DIFF_FILE_GET IPC call. */
export type DiffFileGetResult = { ok: true; patch: FilePatch } | { ok: false; error: string }

export interface Deployment {
  id: string
  companionId: string
  facilityId: string
  taskPrompt: string
  quickPromptUsed?: string
  status: DeploymentStatus
  startedAt: number
  completedAt?: number
  exitCode?: number
  summary?: string
  diffStats?: { filesChanged: number; insertions: number; deletions: number }
  diffFiles?: DiffFileStat[]
  baselineSha?: string
  pendingInput?: { prompt: string; detectedAt: number }
}

export interface LogChunk {
  id: string
  deploymentId: string
  timestamp: number
  stream: 'stdout' | 'stderr' | 'system' | 'thought'
  text: string
  /**
   * Set iff `stream === 'thought'`. Lets the renderer distinguish
   * forward-looking intent cards from backward-looking findings cards
   * without re-parsing the text prefix. Optional so persisted LogChunks
   * from older sessions don't need migration — non-thought streams
   * simply omit it.
   */
  thoughtKind?: 'intent' | 'findings'
}

/**
 * Bump this literal when the seed shape changes incompatibly. The
 * StateManager migration wipes any cached state whose version doesn't
 * match (TODO(Wave 5): preserve user-facing settings + deployments
 * history across bumps once those become editable / valuable).
 */
export type StateSchemaVersion = 2

/** Payload for SOUL_READ IPC call. */
export interface SoulReadPayload {
  companionId: string
}

/** Result for SOUL_READ IPC call. */
export type SoulReadResult = { ok: true; content: string } | { ok: false; error: string }

/** Payload for SOUL_WRITE IPC call. */
export interface SoulWritePayload {
  companionId: string
  content: string
}

/** Result for SOUL_WRITE IPC call. */
export type SoulWriteResult = { ok: true } | { ok: false; error: string }

/** Payload for MEMORY_READ IPC call. */
export interface MemoryReadPayload {
  companionId: string
}

/** Result for MEMORY_READ IPC call. */
export type MemoryReadResult = { ok: true; content: string } | { ok: false; error: string }

/** Payload for BULK_IMPORT_RUN IPC call. */
export interface BulkImportRunPayload {
  selectedPaths: string[]
}

/** A directory discovered by the project scanner. */
export interface DiscoveredProject {
  /** Directory name (basename, not the full path). */
  name: string
  /** Absolute path on disk. */
  path: string
  /** Which marker files/dirs triggered the match. */
  markers: string[]
}

/** Result for BULK_IMPORT_RUN IPC call. */
export type BulkImportRunResult =
  { ok: true; imported: number; facilities: Facility[] } | { ok: false; error: string }

/** Payload for COMPANION_CONFIGURE IPC call. */
export interface CompanionConfigurePayload {
  companionId: string
  runtime?: AgentFamily
  model?: string
  name?: string
}

/** Result for COMPANION_CONFIGURE IPC call. */
export type CompanionConfigureResult =
  { ok: true; cliAvailable: boolean } | { ok: false; error: string }

export type SimpleActionResult = { ok: true } | { ok: false; error: string }

export interface AppState {
  version: StateSchemaVersion
  companions: Companion[]
  facilities: Facility[]
  deployments: Deployment[]
  logChunks: LogChunk[]
  settings: {
    projectsDir: string
    concurrencyCap: number
    ignoredMarkers: string[]
    companionNameOverrides: Record<string, string>
    /**
     * When true, the bay suppresses decorative motion (idle breathing,
     * beacon blinks, walk bob, dust) — the accessibility escape hatch.
     * MechBay deliberately does NOT auto-derive this from the OS
     * `prefers-reduced-motion` setting: the animated bay is the whole
     * point, so the OS reporting "reduce" (common on Windows with
     * animation effects off) shouldn't silently kill it. Defaults to
     * false / full motion; the user opts in via MECH SETTINGS. Optional
     * so pre-existing persisted state stays valid without a schema bump.
     */
    reduceMotion?: boolean
    /** Static scanlines and edge vignette. Defaults on when unset. */
    crtOverlay?: boolean
    /**
     * Desktop notifications + taskbar flash when a deployment finishes,
     * fails, or needs input while the window is unfocused/minimized.
     * Defaults ON when unset, like `crtOverlay` — optional so pre-existing
     * persisted state stays valid without a schema bump.
     */
    missionAlerts?: boolean
  }
  lastScanAt?: number
}
