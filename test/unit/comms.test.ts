import { describe, expect, it } from 'vitest'
import type {
  AppState,
  Companion,
  Deployment,
  DeploymentStatus,
  Facility,
  MechClass
} from '../../src/shared/types'
import {
  BARKS,
  buildCommsMessage,
  commsDetail,
  computeCommsMessages,
  computeCommsTransitions,
  dropStaleHolding,
  pickBark,
  RADIO_RATE,
  type CommsEvent
} from '../../src/renderer/src/comms'

function deployment(status: DeploymentStatus, overrides: Partial<Deployment> = {}): Deployment {
  return {
    id: 'deployment-1',
    companionId: 'atlas-1',
    facilityId: 'lab',
    taskPrompt: 'Survey the reactor controls.',
    status,
    startedAt: 1,
    ...overrides
  }
}

const companions = [
  { id: 'atlas-1', name: 'Atlas-Prime', mechClass: 'atlas' },
  { id: 'raven-1', name: 'Raven-Prime', mechClass: 'raven' }
] as Companion[]
const facilities = [{ id: 'lab', name: 'Research Lab' }] as Facility[]

const events = (prev: Deployment[], next: Deployment[]): CommsEvent[] =>
  computeCommsTransitions(prev, next).map((t) => t.event)

describe('computeCommsTransitions', () => {
  it('acknowledges a new walking-to order', () => {
    expect(events([], [deployment('walking-to')])).toEqual(['acknowledged'])
  })

  it('reports holding for a new queued order, then acknowledges when it moves out', () => {
    expect(events([], [deployment('queued')])).toEqual(['queued'])
    expect(events([deployment('queued')], [deployment('walking-to')])).toEqual(['acknowledged'])
  })

  it('reports on-site work after walking-to', () => {
    expect(events([deployment('walking-to')], [deployment('working')])).toEqual(['working'])
  })

  it('still acknowledges when walking-to was never observed', () => {
    expect(events([], [deployment('working')])).toEqual(['acknowledged', 'working'])
    expect(events([deployment('queued')], [deployment('working')])).toEqual([
      'acknowledged',
      'working'
    ])
  })

  it('asks for input, then resumes without re-announcing arrival', () => {
    expect(events([deployment('working')], [deployment('awaiting-input')])).toEqual([
      'awaiting-input'
    ])
    expect(events([deployment('awaiting-input')], [deployment('working')])).toEqual(['resumed'])
  })

  it.each(['completed', 'failed', 'cancelled'] as const)('reports %s once', (status) => {
    expect(events([deployment('working')], [deployment(status)])).toEqual([status])
    expect(events([deployment(status)], [deployment(status)])).toEqual([])
  })

  it('stays silent for unchanged statuses and the returning phase', () => {
    expect(events([deployment('working')], [deployment('working')])).toEqual([])
    expect(events([deployment('completed')], [deployment('returning')])).toEqual([])
  })
})

describe('buildCommsMessage', () => {
  it('builds callsign, channel and a facility-aware bark from real state', () => {
    const message = buildCommsMessage(
      { event: 'completed', deployment: deployment('completed') },
      companions,
      facilities
    )
    expect(message).toMatchObject({
      callsign: 'Atlas-Prime',
      channel: 'CH 01 · COMPLETE',
      mechClass: 'atlas',
      tone: 'success',
      radioRate: RADIO_RATE.atlas
    })
    expect(
      BARKS.atlas.completed.map((line) => line.replace('{facility}', 'Research Lab'))
    ).toContain(message?.bark)
  })

  it('drops messages for companions that no longer exist', () => {
    expect(
      buildCommsMessage(
        { event: 'working', deployment: deployment('working', { companionId: 'ghost' }) },
        companions,
        facilities
      )
    ).toBeNull()
  })

  it('numbers the channel by roster position', () => {
    const [message] = computeCommsMessages([], {
      deployments: [deployment('walking-to', { companionId: 'raven-1' })],
      companions,
      facilities,
      settings: { concurrencyCap: 3 } as AppState['settings']
    })
    expect(message.channel).toBe('CH 02 · ORDERS')
    expect(message.callsign).toBe('Raven-Prime')
  })

  it('reports holding only when the lane is full, not for the moment before a mission starts', () => {
    const out = deployment('working', { id: 'deployment-0' })
    const fresh = deployment('queued', { companionId: 'raven-1' })
    const radio = (cap: number): string[] =>
      computeCommsMessages([out], {
        deployments: [out, fresh],
        companions,
        facilities,
        settings: { concurrencyCap: cap } as AppState['settings']
      }).map((m) => m.event)
    expect(radio(3)).toEqual([])
    expect(radio(1)).toEqual(['queued'])
  })
})

describe('dropStaleHolding', () => {
  const settings = { concurrencyCap: 1 } as AppState['settings']
  const out = deployment('working', { id: 'deployment-0' })
  const held = deployment('queued', { companionId: 'raven-1' })
  const [holding] = computeCommsMessages([out], {
    deployments: [out, held],
    companions,
    facilities,
    settings
  })
  const pending = { ...holding, key: 'holding:2' }
  const shown = { ...holding, key: 'holding:1' }
  const DRAWN: ReadonlySet<string> = new Set([shown.key])
  const launched = {
    deployments: [
      deployment('completed', { id: 'deployment-0' }),
      deployment('walking-to', { companionId: 'raven-1' })
    ],
    settings
  }

  it('keeps a holding line that has not shown yet while its mission still waits', () => {
    expect(dropStaleHolding([pending], { deployments: [out, held], settings }, DRAWN)).toEqual([
      pending
    ])
  })

  it('drops a holding line that has not shown yet once its mission launched', () => {
    expect(dropStaleHolding([pending], launched, DRAWN)).toEqual([])
  })

  it('leaves a holding line already on screen alone', () => {
    expect(dropStaleHolding([shown], launched, DRAWN)).toEqual([shown])
  })
})

describe('commsDetail', () => {
  it('reports real diff stats on completion', () => {
    const done = deployment('completed', {
      diffStats: { filesChanged: 3, insertions: 42, deletions: 7 }
    })
    expect(commsDetail('completed', done)).toBe('3 files, +42 −7')
    expect(
      commsDetail(
        'completed',
        deployment('completed', { diffStats: { filesChanged: 1, insertions: 0, deletions: 2 } })
      )
    ).toBe('1 file, +0 −2')
  })

  it('omits the detail line when there is no real data', () => {
    expect(commsDetail('completed', deployment('completed'))).toBeUndefined()
    expect(commsDetail('failed', deployment('failed'))).toBeUndefined()
    expect(commsDetail('working', deployment('working'))).toBeUndefined()
  })

  it('shows the exit code on failure', () => {
    expect(commsDetail('failed', deployment('failed', { exitCode: 2 }))).toBe('Exit code 2')
  })
})

describe('bark bank', () => {
  it('is deterministic per deployment id', () => {
    const first = pickBark('raven', 'acknowledged', 'deployment-xyz', 'Foundry')
    for (let i = 0; i < 5; i++) {
      expect(pickBark('raven', 'acknowledged', 'deployment-xyz', 'Foundry')).toBe(first)
    }
  })

  it('varies across deployments', () => {
    const lines = new Set(
      Array.from({ length: 40 }, (_, i) => pickBark('atlas', 'acknowledged', `d-${i}`, 'Lab'))
    )
    expect(lines.size).toBeGreaterThan(1)
  })

  it('keeps every line short: 3+ variants of 7 words or fewer', () => {
    for (const [mechClass, bank] of Object.entries(BARKS) as [
      MechClass,
      Record<CommsEvent, readonly string[]>
    ][]) {
      for (const [event, lines] of Object.entries(bank)) {
        expect(lines.length, `${mechClass}/${event}`).toBeGreaterThanOrEqual(3)
        for (const line of lines) {
          expect(line.split(/\s+/).length, line).toBeLessThanOrEqual(7)
        }
      }
    }
  })
})
