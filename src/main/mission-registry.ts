import { isActive } from '../shared/mission-queue'
import { setDeployment } from './deployment-patch'
import type { StateManager } from './state-manager'

export interface MissionHandle {
  abort: () => Promise<void>
}

/**
 * Abort handles of missions whose agent process is running (P0-11), and the
 * run of every launched mission until it has saved its outcome.
 */
export class MissionRegistry {
  private readonly handles = new Map<string, MissionHandle>()
  private readonly runs = new Set<Promise<void>>()
  private closingNow = false

  /** True once MechBay has begun closing: nothing new may start. */
  get closing(): boolean {
    return this.closingNow
  }

  /** MechBay is closing: refuse new missions and stop any agent that still registers. */
  close(): void {
    this.closingNow = true
  }

  set(missionId: string, handle: MissionHandle): void {
    this.handles.set(missionId, handle)
    // An agent that finished starting after closing began: stop it now, or
    // it would outlive MechBay.
    if (this.closingNow) {
      void Promise.resolve()
        .then(() => handle.abort())
        .catch((err) => {
          console.error(`[shutdown] abort failed for late mission ${missionId}:`, err)
        })
    }
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

  /** Follow a launched mission until it has written its outcome, log and memory. */
  track(run: Promise<void>): void {
    const settled = run.then(
      () => undefined,
      () => undefined
    )
    this.runs.add(settled)
    void settled.then(() => this.runs.delete(settled))
  }

  /** Stop every running agent; gives up waiting after `timeoutMs`. Never rejects. */
  async abortAll(timeoutMs: number): Promise<void> {
    // Through a promise, so a handle that throws instead of rejecting cannot
    // stop the others from being aborted.
    await withTimeout(
      Promise.allSettled(
        [...this.handles.values()].map((h) => Promise.resolve().then(() => h.abort()))
      ),
      timeoutMs
    )
  }

  /** Wait for every launched mission to save its outcome; gives up after `timeoutMs`. Never rejects. */
  async settleAll(timeoutMs: number): Promise<void> {
    await withTimeout(Promise.all([...this.runs]), timeoutMs)
  }
}

/** Resolves when `work` settles or `timeoutMs` passes, whichever is first. */
async function withTimeout(work: Promise<unknown>, timeoutMs: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((r) => {
    timer = setTimeout(r, Math.max(0, timeoutMs))
  })
  try {
    await Promise.race([work, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Closing MechBay: refuse new missions, mark every open mission cancelled
 * (so late exits cannot change the outcome), stop the agents, wait for each
 * mission to save its outcome and memory, then save the last log lines. The
 * waits share one `timeoutMs` budget. Never rejects, so quitting cannot hang
 * on it.
 */
export async function shutdownMissions(deps: {
  state: StateManager
  missions: MissionRegistry
  logs: { flushAll(): void }
  timeoutMs?: number
}): Promise<void> {
  const budget = deps.timeoutMs ?? 8000
  const deadline = Date.now() + budget
  deps.missions.close()
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
  await deps.missions.abortAll(budget)
  // An aborted agent's mission still writes its outcome, diff and memory
  // after the exit: quitting before that would lose them.
  await deps.missions.settleAll(deadline - Date.now())
  try {
    deps.logs.flushAll()
  } catch (err) {
    console.error('[shutdown] writing the last log lines failed:', err)
  }
}
