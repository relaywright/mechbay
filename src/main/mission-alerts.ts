/**
 * Desktop mission alerts — Windows notifications + taskbar flash/progress
 * for deployments that finish, fail, or need input while MechBay isn't
 * the focused window. Two pure pieces (detectMissionEvents,
 * formatMissionAlert) do the actual decision-making so they're testable
 * without touching Electron; MissionAlerts is the thin stateful wiring
 * that subscribes to StateManager and drives BrowserWindow/Notification.
 */
import { Notification, type BrowserWindow } from 'electron'
import type { AppState, Deployment, DeploymentStatus } from '../shared/types'
import type { StateManager } from './state-manager'
import { isActive } from '../shared/mission-queue'

export type MissionEventStatus = 'completed' | 'failed' | 'awaiting-input'

export interface MissionEvent {
  deployment: Deployment
  status: MissionEventStatus
}

function isFirableStatus(status: DeploymentStatus): status is MissionEventStatus {
  return status === 'completed' || status === 'failed' || status === 'awaiting-input'
}

/**
 * Diffs two deployment lists and returns an event for every deployment
 * that just transitioned INTO 'completed' | 'failed' | 'awaiting-input'.
 * A deployment absent from `prev` (brand new, already in a firable state)
 * counts as a transition. A deployment whose status is unchanged between
 * `prev` and `next` never re-fires, even if it's sitting in a firable
 * state both times.
 */
export function detectMissionEvents(prev: Deployment[], next: Deployment[]): MissionEvent[] {
  const prevById = new Map(prev.map((d) => [d.id, d]))
  const events: MissionEvent[] = []
  for (const deployment of next) {
    if (!isFirableStatus(deployment.status)) continue
    const before = prevById.get(deployment.id)
    if (before && before.status === deployment.status) continue
    events.push({ deployment, status: deployment.status })
  }
  return events
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * Pure formatter — turns a MissionEvent into notification copy. Looks up
 * companion.name / facility.name from state and degrades gracefully
 * (generic fallback text) if either was removed out from under the
 * deployment record.
 */
export function formatMissionAlert(
  event: MissionEvent,
  state: Pick<AppState, 'companions' | 'facilities'>
): { title: string; body: string } {
  const { deployment, status } = event
  const companion = state.companions.find((c) => c.id === deployment.companionId)
  const facility = state.facilities.find((f) => f.id === deployment.facilityId)
  const name = companion?.name ?? 'Unknown mech'
  const facilityName = facility?.name ?? 'an unlinked facility'

  if (status === 'completed') {
    const diff = deployment.diffStats
    const body = diff
      ? `${facilityName} · ${diff.filesChanged} file${diff.filesChanged === 1 ? '' : 's'} changed, +${diff.insertions} −${diff.deletions}`
      : `${facilityName} · No changes detected.`
    return { title: `${name} returned`, body: truncate(body, 120) }
  }

  if (status === 'failed') {
    const body = deployment.summary ? deployment.summary : `${facilityName} · Deployment failed.`
    return { title: `${name} is down`, body: truncate(body, 120) }
  }

  // awaiting-input
  const body = `${facilityName} · Waiting for your input.`
  return { title: `${name} needs input`, body: truncate(body, 120) }
}

function hasActiveDeployment(deployments: Deployment[]): boolean {
  return deployments.some((d) => isActive(d.status))
}

export interface NotifyOptions {
  title: string
  body: string
  onClick: () => void
}

function defaultNotify(opts: NotifyOptions): void {
  if (!Notification.isSupported()) return
  const notification = new Notification({ title: opts.title, body: opts.body })
  notification.on('click', opts.onClick)
  notification.show()
}

export interface MissionAlertsDeps {
  win: BrowserWindow
  state: StateManager
  /** Injectable for tests; defaults to a real Electron Notification. */
  notify?: (opts: NotifyOptions) => void
}

export class MissionAlerts {
  private win: BrowserWindow
  private state: StateManager
  private notify: (opts: NotifyOptions) => void
  private prevDeployments: Deployment[]
  private wasActive: boolean

  constructor({ win, state, notify }: MissionAlertsDeps) {
    this.win = win
    this.state = state
    this.notify = notify ?? defaultNotify

    // Seed from current state at construction so boot (crash-recovery
    // sweeps, demo-mode seeding, etc.) never fires a stale alert for
    // deployments that were already completed/failed before MechBay
    // finished starting up.
    const current = this.state.getState()
    this.prevDeployments = current.deployments
    this.wasActive = hasActiveDeployment(current.deployments)
    this.applyProgressBar(this.wasActive)

    this.state.on('stateChanged', this.handleStateChanged)
    this.win.on('focus', this.handleFocus)
  }

  private handleStateChanged = (next: AppState): void => {
    const events = detectMissionEvents(this.prevDeployments, next.deployments)
    this.prevDeployments = next.deployments

    if (events.length > 0 && next.settings.missionAlerts !== false && !this.win.isDestroyed()) {
      const shouldAlert = !this.win.isFocused() || this.win.isMinimized()
      if (shouldAlert) {
        for (const event of events) {
          const { title, body } = formatMissionAlert(event, next)
          this.notify({ title, body, onClick: () => this.focusWindow() })
        }
        this.win.flashFrame(true)
      }
    }

    this.updateProgressBar(next.deployments)
  }

  private handleFocus = (): void => {
    if (this.win.isDestroyed()) return
    this.win.flashFrame(false)
  }

  private focusWindow(): void {
    if (this.win.isDestroyed()) return
    if (this.win.isMinimized()) this.win.restore()
    this.win.focus()
  }

  private updateProgressBar(deployments: Deployment[]): void {
    const active = hasActiveDeployment(deployments)
    if (active === this.wasActive) return
    this.wasActive = active
    this.applyProgressBar(active)
  }

  private applyProgressBar(active: boolean): void {
    if (this.win.isDestroyed()) return
    // Electron 39: options.mode === 'indeterminate' is the documented way
    // to get the marching Windows taskbar progress; the numeric value is
    // ignored in that mode but must still be a valid in-range number.
    if (active) {
      this.win.setProgressBar(1, { mode: 'indeterminate' })
    } else {
      this.win.setProgressBar(-1)
    }
  }
}
