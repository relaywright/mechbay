import { describe, it, expect } from 'vitest'
import type { AppState, Deployment } from '../../src/shared/types'
import { DEFAULT_CONCURRENCY_CAP } from '../../src/shared/mission-queue'
import {
  compassPoint,
  computeCallouts,
  headingFromDelta,
  lanceHeat,
  dropStaleHolding
} from '../../src/renderer/src/cockpit'

function deployment(id: string, status: Deployment['status'], companionId = 'c1'): Deployment {
  return {
    id,
    companionId,
    facilityId: 'f1',
    status,
    taskPrompt: 'x',
    startedAt: 0
  } as Deployment
}

function state(deployments: Deployment[], linked = true, cap = 3): AppState {
  return {
    version: 1,
    companions: [
      { id: 'c1', name: 'Atlas-Prime' },
      { id: 'c2', name: 'Raven-Prime' }
    ],
    facilities: [{ id: 'f1', name: 'Research Lab', path: linked ? '/p' : '' }],
    deployments,
    logChunks: [],
    settings: { concurrencyCap: cap }
  } as unknown as AppState
}

describe('computeCallouts', () => {
  it('stays quiet on first load and when nothing changed', () => {
    const s = state([deployment('d1', 'working')])
    expect(computeCallouts(null, s)).toEqual([])
    expect(computeCallouts(s, s)).toEqual([])
  })

  it('locks the target when a mission launches, including straight from the queue', () => {
    const launched = computeCallouts(state([]), state([deployment('d1', 'walking-to')]))
    expect(launched).toEqual([
      { id: 'd1:launch', text: 'TARGET LOCKED · RESEARCH LAB', tone: 'nominal' }
    ])
    const fromQueue = computeCallouts(
      state([deployment('d1', 'queued')]),
      state([deployment('d1', 'working')])
    )
    expect(fromQueue[0].id).toBe('d1:launch')
  })

  it('does not re-lock when walking-to becomes working', () => {
    const out = computeCallouts(
      state([deployment('d1', 'walking-to')]),
      state([deployment('d1', 'working')])
    )
    expect(out).toEqual([])
  })

  it('stays quiet about a new mission that a free slot is about to start', () => {
    // Every mission is saved as queued first; the scheduler starts it a moment
    // later. With 1 of 3 mechs out, nothing is holding.
    const lane = [deployment('d1', 'working')]
    const out = computeCallouts(state(lane), state([...lane, deployment('d2', 'queued', 'c2')]))
    expect(out).toEqual([])
  })

  it('warns on a queued launch and on input requests', () => {
    const full = [deployment('d1', 'working')]
    const queued = computeCallouts(
      state(full, true, 1),
      state([...full, deployment('d2', 'queued', 'c2')], true, 1)
    )
    expect(queued[0]).toMatchObject({
      text: 'LANCE AT CAPACITY · RAVEN-PRIME HOLDING',
      tone: 'warning'
    })
    const input = computeCallouts(
      state([deployment('d1', 'working')]),
      state([deployment('d1', 'awaiting-input')])
    )
    expect(input[0]).toMatchObject({ text: 'INPUT REQUIRED · ATLAS-PRIME', tone: 'warning' })
  })

  it('announces outcomes, then stands the lance down when nothing is left', () => {
    const done = computeCallouts(
      state([deployment('d1', 'working')]),
      state([deployment('d1', 'completed')])
    )
    expect(done.map((c) => c.text)).toEqual([
      'OBJECTIVE COMPLETE · RESEARCH LAB',
      'ALL UNITS STANDING BY'
    ])
    const down = computeCallouts(
      state([deployment('d1', 'working'), deployment('d2', 'working', 'c2')]),
      state([deployment('d1', 'failed'), deployment('d2', 'working', 'c2')])
    )
    expect(down).toEqual([
      { id: 'd1:failed', text: 'WARNING · ATLAS-PRIME DOWN', tone: 'critical' }
    ])
  })

  it('brings a nav point online when a facility gets linked', () => {
    const out = computeCallouts(state([], false), state([], true))
    expect(out).toEqual([
      { id: 'f1:linked', text: 'NAV POINT ONLINE · RESEARCH LAB', tone: 'nominal' }
    ])
  })
})

describe('dropStaleHolding', () => {
  // A full lane (cap 1): d2 really waits, and its HOLDING line is queued
  // behind another callout that is still on screen.
  const full = [deployment('d1', 'working')]
  const waitingState = state([...full, deployment('d2', 'queued', 'c2')], true, 1)
  const holding = computeCallouts(state(full, true, 1), waitingState)
  const onScreen = {
    id: 'd0:complete',
    text: 'OBJECTIVE COMPLETE · RESEARCH LAB',
    tone: 'nominal' as const
  }

  it('keeps a waiting HOLDING line while the mission is still in line', () => {
    const queue = [onScreen, ...holding]
    expect(dropStaleHolding(queue, waitingState)).toEqual(queue)
  })

  it('drops a waiting HOLDING line once its mission has launched', () => {
    const launched = state(
      [deployment('d1', 'completed'), deployment('d2', 'walking-to', 'c2')],
      true,
      1
    )
    expect(dropStaleHolding([onScreen, ...holding], launched)).toEqual([onScreen])
  })

  it('lets a HOLDING line already on screen play out', () => {
    const launched = state(
      [deployment('d1', 'completed'), deployment('d2', 'walking-to', 'c2')],
      true,
      1
    )
    expect(dropStaleHolding(holding, launched)).toEqual(holding)
  })
})

describe('lanceHeat', () => {
  it('measures active missions against the cap', () => {
    expect(lanceHeat(state([]))).toMatchObject({ active: 0, level: 0, band: 'cool' })
    expect(
      lanceHeat(state([deployment('a', 'working'), deployment('b', 'walking-to')]))
    ).toMatchObject({ active: 2, level: 2 / 3, band: 'warm' })
    const hot = lanceHeat(
      state([
        deployment('a', 'working'),
        deployment('b', 'awaiting-input'),
        deployment('c', 'returning'),
        deployment('d', 'queued')
      ])
    )
    expect(hot).toMatchObject({ active: 3, queued: 1, level: 1, band: 'hot' })
  })

  it('ignores finished missions and reads a zero cap the way the scheduler does', () => {
    // The queue runs DEFAULT_CONCURRENCY_CAP missions when the saved cap is
    // unusable, so the gauge shows that many slots too.
    expect(lanceHeat(state([deployment('a', 'completed')], true, 0))).toMatchObject({
      active: 0,
      cap: DEFAULT_CONCURRENCY_CAP,
      band: 'cool'
    })
  })
})

describe('headingFromDelta / compassPoint', () => {
  it('measures clockwise from up-screen north', () => {
    expect(headingFromDelta(0, -1)).toBeCloseTo(0, 5)
    expect(headingFromDelta(1, 0)).toBeCloseTo(90, 5)
    expect(headingFromDelta(0, 1)).toBeCloseTo(180, 5)
    expect(headingFromDelta(-1, 0)).toBeCloseTo(270, 5)
  })

  it('snaps to the nearest of eight points', () => {
    expect(compassPoint(0)).toBe('N')
    expect(compassPoint(130)).toBe('SE')
    expect(compassPoint(350)).toBe('N')
    expect(compassPoint(-90)).toBe('W')
  })
})
