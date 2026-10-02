import { describe, expect, it } from 'vitest'
import {
  capDeployments,
  freeSlots,
  hasOpenMission,
  missionsToStart,
  queuePosition,
  queuedInOrder
} from '../../src/shared/mission-queue'
import { MAX_SAVED_MISSIONS } from '../../src/shared/defaults'
import type { Deployment, DeploymentStatus } from '../../src/shared/types'

const d = (
  id: string,
  companionId: string,
  status: DeploymentStatus,
  startedAt: number
): Deployment => ({
  id,
  companionId,
  facilityId: 'f',
  taskPrompt: id,
  status,
  startedAt
})
const state = (deployments: Deployment[], concurrencyCap = 3): never =>
  ({ deployments, settings: { concurrencyCap } }) as never

describe('mission queue rules', () => {
  it('orders queued missions oldest first, newest-first storage notwithstanding', () => {
    const list = [
      d('c', 'm3', 'queued', 30),
      d('b', 'm2', 'queued', 20),
      d('a', 'm1', 'queued', 10)
    ]
    expect(queuedInOrder(list).map((x) => x.id)).toEqual(['a', 'b', 'c'])
    expect(queuePosition(list, 'c')).toBe(3)
    expect(queuePosition(list, 'zzz')).toBeNull()
  })

  it('breaks a same-millisecond tie by id', () => {
    expect(
      queuedInOrder([d('b', 'm2', 'queued', 5), d('a', 'm1', 'queued', 5)]).map((x) => x.id)
    ).toEqual(['a', 'b'])
  })

  it('starts as many as there are free slots, one per mech', () => {
    const list = [
      d('run', 'm1', 'working', 1),
      d('q1', 'm1', 'queued', 2),
      d('q2', 'm2', 'queued', 3),
      d('q3', 'm3', 'queued', 4),
      d('q4', 'm4', 'queued', 5)
    ]
    expect(freeSlots(state(list))).toBe(2)
    expect(missionsToStart(state(list)).map((x) => x.id)).toEqual(['q2', 'q3'])
  })

  it('knows when a mech already has an open mission', () => {
    expect(hasOpenMission([d('a', 'm1', 'queued', 1)], 'm1')).toBe(true)
    expect(hasOpenMission([d('a', 'm1', 'completed', 1)], 'm1')).toBe(false)
  })

  it('trims history without ever dropping an open mission', () => {
    const ended = Array.from({ length: 250 }, (_, i) => d(`e${i}`, 'm1', 'completed', 1000 - i))
    const open = d('old-queued', 'm2', 'queued', 1)
    const capped = capDeployments([...ended, open], 200)
    expect(capped).toHaveLength(200)
    expect(capped.some((x) => x.id === 'old-queued')).toBe(true)
    expect(capped[0].id).toBe('e0')
  })

  it('trims to the saved-mission limit by default', () => {
    const ended = Array.from({ length: MAX_SAVED_MISSIONS + 5 }, (_, i) =>
      d(`e${i}`, 'm1', 'failed', 1000 - i)
    )
    expect(capDeployments(ended)).toHaveLength(MAX_SAVED_MISSIONS)
  })
})
