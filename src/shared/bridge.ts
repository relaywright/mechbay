import type {
  AgentFamily,
  AppMode,
  AppState,
  BulkImportRunResult,
  CompanionConfigurePayload,
  CompanionConfigureResult,
  Deployment,
  DeploymentStatus,
  DiffFileGetResult,
  DiscoveredProject,
  Facility,
  FsNode,
  LogChunk,
  MemoryReadResult,
  SimpleActionResult,
  SoulReadResult,
  SoulWriteResult,
  StateHealth
} from './types'

/**
 * The single interface the renderer may call (spec 7.5). The Electron
 * preload implements it today; the web demo (Phase 2) implements it with
 * a simulation. A shell that cannot perform a method throws
 * DesktopOnlyError or NotYetAvailableError from bridge-errors.ts.
 */

/** The spec's mission lifecycle, derived from the stored status. */
export type MissionState = 'queued' | 'running' | 'review' | 'done' | 'failed' | 'cancelled'

export function missionStateOf(status: DeploymentStatus): MissionState {
  switch (status) {
    case 'queued':
      return 'queued'
    case 'walking-to':
    case 'working':
    case 'awaiting-input':
    case 'returning':
      return 'running'
    case 'completed':
      return 'done'
    case 'failed':
      return 'failed'
    case 'cancelled':
      return 'cancelled'
  }
}

export interface DeployStartArgs {
  companionId: string
  facilityId: string
  taskPrompt: string
  quickPromptUsed?: string
}

export interface DeployStartResult {
  deploymentId: string
  status: DeploymentStatus
}

export interface SettingsPatch {
  reduceMotion?: boolean
  crtOverlay?: boolean
  missionAlerts?: boolean
  sound?: boolean
  /** 0..1; the main process clamps it. */
  soundVolume?: number
}

export interface LogsBridge {
  /** Saved entries for one mission, oldest first; only those after `afterSeq` when given. */
  history(missionId: string, afterSeq?: number): Promise<LogChunk[]>
  /** Live entries for every mission, in batches. Returns an unsubscribe function. */
  subscribe(cb: (entries: LogChunk[]) => void): () => void
}

export interface ReviewBridge {
  approve(missionId: string): Promise<SimpleActionResult>
  reject(missionId: string): Promise<SimpleActionResult>
}

export interface MechbayBridge {
  getAppMode(): Promise<AppMode>
  getState(): Promise<AppState>
  getStateHealth(): Promise<StateHealth>
  onStateChange(cb: (state: AppState) => void): () => void
  deployStart(args: DeployStartArgs): Promise<DeployStartResult>
  /** Cancel a queued mission or recall a running one. */
  deployAbort(missionId: string): Promise<SimpleActionResult>
  logs: LogsBridge
  review: ReviewBridge
  configureCompanion(payload: CompanionConfigurePayload): Promise<CompanionConfigureResult>
  bulkImportRun(selectedPaths: string[]): Promise<BulkImportRunResult>
  updateSettings(patch: SettingsPatch): Promise<SimpleActionResult>
  diffFileGet(deploymentId: string, path: string): Promise<DiffFileGetResult>
  onRecoveryZombies(cb: (zombies: Deployment[]) => void): () => void
  fsReadDir(path: string): Promise<FsNode[]>
  fsReadFile(path: string): Promise<string>
  addFacilityFromPicker(tile: { x: number; y: number }): Promise<Facility | null>
  linkFacility(facilityId: string): Promise<Facility | null>
  facilityRemove(facilityId: string): Promise<SimpleActionResult>
  fieldReset(): Promise<SimpleActionResult>
  soulRead(companionId: string): Promise<SoulReadResult>
  soulWrite(companionId: string, content: string): Promise<SoulWriteResult>
  memoryRead(companionId: string): Promise<MemoryReadResult>
  /** Always scans the projects folder from Settings; the renderer cannot pick the root. */
  scanProjects(): Promise<DiscoveredProject[]>
  secretsSet(runtime: AgentFamily, value: string): Promise<{ ok: boolean; error?: string }>
  secretsStatus(): Promise<Record<AgentFamily, boolean>>
}
