import { describe, expect, it } from 'vitest'
import {
  boardOrder,
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

  it('falls back to 3 at once when the saved limit is damaged, so the queue never stalls or floods', () => {
    const queued = ['m1', 'm2', 'm3', 'm4', 'm5'].map((m, i) => d(`q-${m}`, m, 'queued', i))
    for (const damaged of [
      0,
      -2,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      '4' as never,
      null as never
    ]) {
      expect(freeSlots(state(queued, damaged))).toBe(3)
      expect(missionsToStart(state(queued, damaged))).toHaveLength(3)
    }
  })

  it('rounds a fractional saved limit down, never below one', () => {
    const queued = ['m1', 'm2', 'm3'].map((m, i) => d(`q-${m}`, m, 'queued', i))
    expect(freeSlots(state(queued, 2.7))).toBe(2)
    expect(freeSlots(state(queued, 0.5))).toBe(1)
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

describe('sortie board order', () => {
  it('lists running missions, then the line in the same order as its #N labels, then ended ones newest first', () => {
    const list = [
      d('done-old', 'm1', 'completed', 10),
      d('q-b', 'm2', 'queued', 50),
      d('run', 'm3', 'working', 40),
      d('q-a', 'm4', 'queued', 50),
      d('done-new', 'm5', 'failed', 30)
    ]
    const order = boardOrder(list).map((x) => x.id)
    expect(order).toEqual(['run', 'q-a', 'q-b', 'done-new', 'done-old'])
    // Same tie-break as the "#N in line" label: q-a is #1.
    expect(queuePosition(list, 'q-a')).toBe(1)
  })

  it('does not reorder the list it was given', () => {
    const list = [d('b', 'm1', 'queued', 2), d('a', 'm2', 'queued', 1)]
    boardOrder(list)
    expect(list.map((x) => x.id)).toEqual(['b', 'a'])
  })
})
