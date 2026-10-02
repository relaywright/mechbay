import { describe, expect, it } from 'vitest'
import { computeServiceRecord, RANK_THRESHOLDS } from '../../src/renderer/src/service-record'
import type { Deployment } from '../../src/shared/types'

const COMPANION_A = '01ATLAS'
const COMPANION_B = '01MARAUDER'

function deployment(overrides: Partial<Deployment>): Deployment {
  return {
    id: overrides.id ?? `dep-${Math.random().toString(36).slice(2)}`,
    companionId: COMPANION_A,
    facilityId: 'fac-research-lab',
    taskPrompt: 'Refactor the auth module',
    status: 'completed',
    startedAt: 1_000,
    completedAt: 2_000,
    ...overrides
  }
}

describe('computeServiceRecord', () => {
  it('returns a zeroed Recruit record for a companion with no history', () => {
    const record = computeServiceRecord(COMPANION_A, [])
    expect(record).toMatchObject({
      sorties: 0,
      completed: 0,
      failed: 0,
      successRate: null,
      linesChanged: 0,
      filesTouched: 0,
      timeInFieldMs: 0,
      xp: 0,
      rank: {
        tier: 0,
        title: 'Recruit',
        nextTitle: 'Cadet',
        xpIntoTier: 0,
        xpForNext: 100,
        progress: 0
      }
    })
  })

  it('ignores cancelled, queued, and in-flight deployments', () => {
    const deployments = [
      deployment({ id: 'd1', status: 'cancelled' }),
      deployment({ id: 'd2', status: 'queued', completedAt: undefined }),
      deployment({ id: 'd3', status: 'working', completedAt: undefined }),
      deployment({ id: 'd4', status: 'walking-to', completedAt: undefined }),
      deployment({ id: 'd5', status: 'awaiting-input', completedAt: undefined })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.sorties).toBe(0)
    expect(record.xp).toBe(0)
    expect(record.rank.title).toBe('Recruit')
  })

  it('ignores other companions deployments entirely', () => {
    const deployments = [
      deployment({ id: 'd1', companionId: COMPANION_B, status: 'completed' }),
      deployment({ id: 'd2', companionId: COMPANION_B, status: 'failed' })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.sorties).toBe(0)
    expect(record.xp).toBe(0)
  })

  it('counts completed and failed as sorties and computes rounded-left success rate', () => {
    const deployments = [
      deployment({ id: 'd1', status: 'completed' }),
      deployment({ id: 'd2', status: 'completed' }),
      deployment({ id: 'd3', status: 'failed' })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.sorties).toBe(3)
    expect(record.completed).toBe(2)
    expect(record.failed).toBe(1)
    // Left to the UI to round/format — assert the raw fraction.
    expect(record.successRate).toBeCloseTo(2 / 3)
  })

  it('caps the per-sortie line-change XP bonus at 50', () => {
    const deployments = [
      deployment({
        id: 'd1',
        status: 'completed',
        diffStats: { filesChanged: 12, insertions: 4000, deletions: 1000 }
      })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    // 100 (completed) + min(50, floor(5000/10)=500) = 150
    expect(record.xp).toBe(150)
    expect(record.linesChanged).toBe(5000)
    expect(record.filesTouched).toBe(12)
  })

  it('awards 100 xp per completed sortie plus an uncapped-under-50 line bonus, and 20 per failed sortie', () => {
    const deployments = [
      deployment({
        id: 'd1',
        status: 'completed',
        diffStats: { filesChanged: 2, insertions: 30, deletions: 15 }
      }),
      deployment({
        id: 'd2',
        status: 'failed',
        diffStats: { filesChanged: 3, insertions: 9, deletions: 9 }
      })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    // completed: 100 + floor(45/10)=4 => 104. failed: 20. total 124.
    expect(record.xp).toBe(124)
    // Failed sorties never contribute lines/files — only completed ones do.
    expect(record.linesChanged).toBe(45)
    expect(record.filesTouched).toBe(2)
  })

  it('guards against a corrupt record where completedAt precedes startedAt', () => {
    const deployments = [
      deployment({ id: 'd1', status: 'completed', startedAt: 5_000, completedAt: 1_000 })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.timeInFieldMs).toBe(0)
  })

  it('sums time in field only across sorties with both timestamps present', () => {
    const deployments = [
      deployment({ id: 'd1', status: 'completed', startedAt: 0, completedAt: 90_000 }),
      deployment({ id: 'd2', status: 'failed', startedAt: 1_000, completedAt: 2_500 })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.timeInFieldMs).toBe(90_000 + 1_500)
  })

  it.each(RANK_THRESHOLDS.filter((t) => t.tier > 0))(
    'lands exactly on tier %# ($title) at the threshold xp value',
    (threshold) => {
      // Build exactly `threshold.xp` xp from completed sorties with no
      // diff stats (each worth a flat 100), padding the remainder with a
      // single sortie carrying the exact leftover as a line bonus.
      const wholeSorties = Math.floor(threshold.xp / 100)
      const remainder = threshold.xp - wholeSorties * 100
      const deployments: Deployment[] = []
      for (let i = 0; i < wholeSorties; i++) {
        deployments.push(deployment({ id: `d${i}`, status: 'completed' }))
      }
      if (remainder > 0) {
        // remainder xp comes from the line-change bonus: floor(lines/10) = remainder
        deployments.push(
          deployment({
            id: 'd-remainder',
            status: 'completed',
            diffStats: { filesChanged: 1, insertions: remainder * 10, deletions: 0 }
          })
        )
      }
      const record = computeServiceRecord(COMPANION_A, deployments)
      expect(record.xp).toBe(threshold.xp)
      expect(record.rank.tier).toBe(threshold.tier)
      expect(record.rank.title).toBe(threshold.title)
      expect(record.rank.xpIntoTier).toBe(0)
    }
  )

  it('reports progress 1 and no next title at max rank (Ace)', () => {
    const deployments = Array.from({ length: 50 }, (_, i) =>
      deployment({ id: `d${i}`, status: 'completed' })
    )
    const record = computeServiceRecord(COMPANION_A, deployments)
    expect(record.xp).toBe(5_000)
    expect(record.rank).toMatchObject({
      tier: 5,
      title: 'Ace',
      nextTitle: null,
      xpForNext: null,
      progress: 1
    })
  })

  it('reports fractional progress toward the next rank mid-tier', () => {
    // 250 xp = Cadet tier (100) + 150 into a 300-wide band to MechWarrior (400)
    const deployments = [
      deployment({ id: 'd1', status: 'completed' }),
      deployment({ id: 'd2', status: 'completed' }),
      deployment({
        id: 'd3',
        status: 'completed',
        diffStats: { filesChanged: 1, insertions: 500, deletions: 0 }
      })
    ]
    const record = computeServiceRecord(COMPANION_A, deployments)
    // 100 + 100 + (100 + 50 capped) = 350
    expect(record.xp).toBe(350)
    expect(record.rank).toMatchObject({ tier: 1, title: 'Cadet', nextTitle: 'MechWarrior' })
    expect(record.rank.xpIntoTier).toBe(250)
    expect(record.rank.xpForNext).toBe(300)
    expect(record.rank.progress).toBeCloseTo(250 / 300)
  })
})
