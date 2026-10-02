import { isActive } from '../shared/mission-queue'
import { setDeployment } from './deployment-patch'
import type { StateManager } from './state-manager'

export interface MissionHandle {
  abort: () => Promise<void>
}

/** Abort handles of missions whose agent process is running (P0-11). */
export class MissionRegistry {
  private readonly handles = new Map<string, MissionHandle>()

  set(missionId: string, handle: MissionHandle): void {
    this.handles.set(missionId, handle)
  }

  get(missionId: string): MissionHandle | undefined {
    return this.handles.get(missionId)
  }

  delete(missionId: string): void {
    this.handles.delete(missionId)
  }

  ids(): string[] {
    return [...this.handles.keys()]
  }

  /** Stop every running agent; gives up waiting after `timeoutMs`. Never rejects. */
  async abortAll(timeoutMs: number): Promise<void> {
    // Through a promise, so a handle that throws instead of rejecting cannot
    // stop the others from being aborted.
    const all = Promise.allSettled(
      [...this.handles.values()].map((h) => Promise.resolve().then(() => h.abort()))
    )
    let timer: ReturnType<typeof setTimeout> | undefined
    const timeout = new Promise<void>((r) => {
      timer = setTimeout(r, timeoutMs)
    })
    try {
      await Promise.race([all, timeout])
    } finally {
      clearTimeout(timer)
    }
  }
}

/**
 * Closing MechBay: mark every open mission cancelled first (so nothing new
 * starts and late exits cannot change the outcome), then stop the agents,
 * then save the last log lines. Never rejects, so quitting cannot hang on it.
 */
export async function shutdownMissions(deps: {
  state: StateManager
  missions: MissionRegistry
  logs: { flushAll(): void }
  timeoutMs?: number
}): Promise<void> {
  try {
    const now = Date.now()
    for (const d of deps.state.getState().deployments) {
      if (d.status === 'queued') {
        setDeployment(deps.state, d.id, {
          status: 'cancelled',
          completedAt: now,
          summary: 'Cancelled: MechBay closed before it started.'
        })
      } else if (isActive(d.status)) {
        setDeployment(deps.state, d.id, {
          status: 'cancelled',
          completedAt: now,
          summary: 'Recalled when MechBay closed.'
        })
      }
    }
  } catch (err) {
    console.error('[shutdown] marking missions cancelled failed:', err)
  }
  // Stop the agents even if saving the outcome failed: a mission left
  // "working" is swept as interrupted on the next start.
  await deps.missions.abortAll(deps.timeoutMs ?? 8000)
  try {
    deps.logs.flushAll()
  } catch (err) {
    console.error('[shutdown] writing the last log lines failed:', err)
  }
}
