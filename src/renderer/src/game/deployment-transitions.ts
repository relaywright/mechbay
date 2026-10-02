import type { Deployment } from '../../../shared/types'

export type DeploymentAction =
  | { kind: 'walk-to-facility'; companionId: string; facilityId: string; deploymentId: string }
  | { kind: 'start-working'; companionId: string; facilityId: string }
  | { kind: 'stop-working'; companionId: string; facilityId: string }
  | { kind: 'dead-in-field'; companionId: string }
  | { kind: 'completion-bubble'; companionId: string; deploymentId: string }
  | { kind: 'walk-home'; companionId: string }

export function computeDeploymentActions(
  prevDeployments: Deployment[],
  nextDeployments: Deployment[]
): DeploymentAction[] {
  const previousStatuses = new Map(
    prevDeployments.map((deployment) => [deployment.id, deployment.status])
  )
  const actions: DeploymentAction[] = []

  for (const deployment of nextDeployments) {
    const prevStatus = previousStatuses.get(deployment.id)
    // The walk fires when a deployment enters walking-to — but ALSO when it
    // first appears already 'working'. The main process flips walking-to →
    // working within the same tick, so React's batching can coalesce both
    // broadcasts into one snapshot and the walking-to state is never
    // observed. Emitted before start-working so the scene's active-walk
    // tracking defers the work sway until the mech actually arrives.
    const entersWalkingTo = deployment.status === 'walking-to' && prevStatus !== 'walking-to'
    const missedWalkingTo =
      deployment.status === 'working' && (prevStatus === undefined || prevStatus === 'queued')
    if (entersWalkingTo || missedWalkingTo) {
      actions.push({
        kind: 'walk-to-facility',
        companionId: deployment.companionId,
        facilityId: deployment.facilityId,
        deploymentId: deployment.id
      })
    }
    // A queued mission that could not start (building removed, folder
    // unlinked) failed in the bay: the mech never left, so it does not fall.
    if (deployment.status === 'failed' && prevStatus !== 'failed' && prevStatus !== 'queued') {
      actions.push({ kind: 'dead-in-field', companionId: deployment.companionId })
    }
    if (deployment.status === 'working' && prevStatus !== 'working') {
      actions.push({
        kind: 'start-working',
        companionId: deployment.companionId,
        facilityId: deployment.facilityId
      })
    }
    if (deployment.status !== 'working' && prevStatus === 'working') {
      actions.push({
        kind: 'stop-working',
        companionId: deployment.companionId,
        facilityId: deployment.facilityId
      })
    }
    if (deployment.status === 'completed' && prevStatus === 'working') {
      actions.push({
        kind: 'completion-bubble',
        companionId: deployment.companionId,
        deploymentId: deployment.id
      })
    }
    // A mission cancelled while queued never left the bay: no walk home.
    if (
      (deployment.status === 'completed' || deployment.status === 'cancelled') &&
      prevStatus !== 'queued' &&
      prevStatus !== 'completed' &&
      prevStatus !== 'cancelled'
    ) {
      actions.push({ kind: 'walk-home', companionId: deployment.companionId })
    }
  }

  return actions
}
