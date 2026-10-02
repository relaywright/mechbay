import type { Deployment } from '../shared/types'
import { isTerminal } from '../shared/mission-queue'
import type { StateManager } from './state-manager'

/**
 * Update one mission. Once a mission has ended, its outcome (status,
 * completedAt, summary, exitCode) is final: a process that exits after
 * being recalled cannot turn "cancelled" into "failed". Other fields, such
 * as the diff, still merge.
 */
export function setDeployment(state: StateManager, id: string, patch: Partial<Deployment>): void {
  state.updateState((prev) => ({
    ...prev,
    deployments: prev.deployments.map((d) => {
      if (d.id !== id) return d
      if (!isTerminal(d.status)) return { ...d, ...patch }
      const { status: _s, completedAt: _c, summary: _m, exitCode: _e, ...rest } = patch
      return { ...d, ...rest }
    })
  }))
}
