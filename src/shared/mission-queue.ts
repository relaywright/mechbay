import type { AppState, Deployment, DeploymentStatus } from './types'
import { MAX_SAVED_MISSIONS } from './defaults'

/** Queue rules (P0-10), shared by the main process and the UI. Pure functions. */

export const ACTIVE_STATUSES: readonly DeploymentStatus[] = [
  'walking-to',
  'working',
  'awaiting-input',
  'returning'
]
export const TERMINAL_STATUSES: readonly DeploymentStatus[] = ['completed', 'failed', 'cancelled']

export const isActive = (status: DeploymentStatus): boolean => ACTIVE_STATUSES.includes(status)
export const isTerminal = (status: DeploymentStatus): boolean => TERMINAL_STATUSES.includes(status)
/** Queued or running: the mech is spoken for. */
export const isOpen = (status: DeploymentStatus): boolean => !isTerminal(status)

const byAge = (a: Deployment, b: Deployment): number =>
  a.startedAt - b.startedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)

export function queuedInOrder(deployments: Deployment[]): Deployment[] {
  return deployments.filter((d) => d.status === 'queued').sort(byAge)
}

/** 1-based place in line, or null when the mission is not queued. */
export function queuePosition(deployments: Deployment[], id: string): number | null {
  const index = queuedInOrder(deployments).findIndex((d) => d.id === id)
  return index === -1 ? null : index + 1
}

export function freeSlots(state: Pick<AppState, 'deployments' | 'settings'>): number {
  const running = state.deployments.filter((d) => isActive(d.status)).length
  return Math.max(0, state.settings.concurrencyCap - running)
}

/** Which queued missions should start now: oldest first, one per mech, up to the free slots. */
export function missionsToStart(state: Pick<AppState, 'deployments' | 'settings'>): Deployment[] {
  let slots = freeSlots(state)
  const busy = new Set(
    state.deployments.filter((d) => isActive(d.status)).map((d) => d.companionId)
  )
  const start: Deployment[] = []
  for (const mission of queuedInOrder(state.deployments)) {
    if (slots === 0) break
    if (busy.has(mission.companionId)) continue
    start.push(mission)
    busy.add(mission.companionId)
    slots--
  }
  return start
}

export function hasOpenMission(deployments: Deployment[], companionId: string): boolean {
  return deployments.some((d) => d.companionId === companionId && isOpen(d.status))
}

/** Trim history (newest first) to `max`, never dropping a queued or running mission. */
export function capDeployments(list: Deployment[], max = MAX_SAVED_MISSIONS): Deployment[] {
  const openCount = list.filter((d) => isOpen(d.status)).length
  let room = Math.max(0, max - openCount)
  return list.filter((d) => {
    if (isOpen(d.status)) return true
    if (room === 0) return false
    room--
    return true
  })
}
