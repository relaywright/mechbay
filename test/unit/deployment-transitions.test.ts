import { describe, expect, it } from 'vitest'
import type { Deployment, DeploymentStatus } from '../../src/shared/types'
import { computeDeploymentActions } from '../../src/renderer/src/game/deployment-transitions'

function deployment(status: DeploymentStatus): Deployment {
  return {
    id: 'deployment-1',
    companionId: 'companion-1',
    facilityId: 'facility-1',
    taskPrompt: 'Test',
    status,
    startedAt: 1
  }
}

describe('computeDeploymentActions', () => {
  it('walks a brand-new walking-to deployment to its facility', () => {
    expect(computeDeploymentActions([], [deployment('walking-to')])).toEqual([
      {
        kind: 'walk-to-facility',
        companionId: 'companion-1',
        facilityId: 'facility-1',
        deploymentId: 'deployment-1'
      }
    ])
  })

  it('marks a brand-new failed deployment dead in the field', () => {
    expect(computeDeploymentActions([], [deployment('failed')])).toEqual([
      { kind: 'dead-in-field', companionId: 'companion-1' }
    ])
  })

  it('starts working after walking-to', () => {
    expect(computeDeploymentActions([deployment('walking-to')], [deployment('working')])).toEqual([
      { kind: 'start-working', companionId: 'companion-1', facilityId: 'facility-1' }
    ])
  })

  it('stops working and dies when working fails', () => {
    expect(computeDeploymentActions([deployment('working')], [deployment('failed')])).toEqual([
      { kind: 'dead-in-field', companionId: 'companion-1' },
      { kind: 'stop-working', companionId: 'companion-1', facilityId: 'facility-1' }
    ])
  })

  it('stops working, shows completion, and walks home when working completes', () => {
    expect(computeDeploymentActions([deployment('working')], [deployment('completed')])).toEqual([
      { kind: 'stop-working', companionId: 'companion-1', facilityId: 'facility-1' },
      { kind: 'completion-bubble', companionId: 'companion-1', deploymentId: 'deployment-1' },
      { kind: 'walk-home', companionId: 'companion-1' }
    ])
  })

  it.each<DeploymentStatus>([
    'queued',
    'walking-to',
    'working',
    'failed',
    'completed',
    'cancelled'
  ])('emits no actions when %s is unchanged', (status) =>
    expect(computeDeploymentActions([deployment(status)], [deployment(status)])).toEqual([])
  )

  it('walks when a queued deployment advances to walking-to', () => {
    expect(computeDeploymentActions([deployment('queued')], [deployment('walking-to')])).toEqual([
      {
        kind: 'walk-to-facility',
        companionId: 'companion-1',
        facilityId: 'facility-1',
        deploymentId: 'deployment-1'
      }
    ])
  })

  // The walking-to status lives for well under a millisecond in the main
  // process, so React's state batching can (and in the drag→modal flow,
  // reliably does) coalesce the walking-to and working broadcasts into one
  // snapshot — the renderer's first sighting of the deployment is already
  // 'working'. The walk must fire anyway, BEFORE start-working, so the
  // scene's active-walk tracking can defer the work sway until arrival.
  it('still walks when the first observed snapshot is already working (coalesced broadcasts)', () => {
    expect(computeDeploymentActions([], [deployment('working')])).toEqual([
      {
        kind: 'walk-to-facility',
        companionId: 'companion-1',
        facilityId: 'facility-1',
        deploymentId: 'deployment-1'
      },
      { kind: 'start-working', companionId: 'companion-1', facilityId: 'facility-1' }
    ])
  })

  it('still walks when queued jumps straight to working (walking-to snapshot missed)', () => {
    expect(computeDeploymentActions([deployment('queued')], [deployment('working')])).toEqual([
      {
        kind: 'walk-to-facility',
        companionId: 'companion-1',
        facilityId: 'facility-1',
        deploymentId: 'deployment-1'
      },
      { kind: 'start-working', companionId: 'companion-1', facilityId: 'facility-1' }
    ])
  })

  it('a mission cancelled while queued sends no walk-home', () => {
    expect(computeDeploymentActions([deployment('queued')], [deployment('cancelled')])).toEqual([])
  })

  it('a queued mission that fails to start does not knock the mech down in the field', () => {
    expect(computeDeploymentActions([deployment('queued')], [deployment('failed')])).toEqual([])
  })

  it('does not re-walk when walking-to advances to working (walk already fired)', () => {
    expect(computeDeploymentActions([deployment('walking-to')], [deployment('working')])).toEqual([
      { kind: 'start-working', companionId: 'companion-1', facilityId: 'facility-1' }
    ])
  })
})
