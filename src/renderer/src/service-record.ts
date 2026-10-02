/**
 * Pilot service records — derives sortie counts, XP, and rank purely from
 * a companion's deployment history. No schema change: everything here is
 * computed on the fly from `AppState.deployments` (capped at 200, see
 * ipc.ts `.slice(0, 200)`), so a rank can never drift from the data that
 * produced it and there's nothing to migrate if the formula changes.
 */
import type { Deployment } from '../../shared/types'

export interface RankThreshold {
  tier: number
  title: string
  xp: number
}

/**
 * Shared by computeServiceRecord and the UI (CrewRoster / CompanionPanel)
 * so the tier boundaries only live in one place. Ordered ascending by xp;
 * tier === index.
 */
export const RANK_THRESHOLDS: RankThreshold[] = [
  { tier: 0, title: 'Recruit', xp: 0 },
  { tier: 1, title: 'Cadet', xp: 100 },
  { tier: 2, title: 'MechWarrior', xp: 400 },
  { tier: 3, title: 'Veteran', xp: 1000 },
  { tier: 4, title: 'Elite', xp: 2500 },
  { tier: 5, title: 'Ace', xp: 5000 }
]

export interface ServiceRecordRank {
  tier: number
  title: string
  nextTitle: string | null
  xpIntoTier: number
  xpForNext: number | null
  /** 0..1, 1 at max rank (nothing left to progress toward). */
  progress: number
}

export interface ServiceRecord {
  sorties: number
  completed: number
  failed: number
  /** completed / sorties, null when there have been zero sorties. */
  successRate: number | null
  linesChanged: number
  filesTouched: number
  timeInFieldMs: number
  xp: number
  rank: ServiceRecordRank
}

const MAX_LINE_XP_PER_SORTIE = 50
const XP_PER_COMPLETED = 100
const XP_PER_FAILED = 20

function rankForXp(xp: number): ServiceRecordRank {
  // RANK_THRESHOLDS is ascending, so the current tier is the last one
  // whose xp requirement we've cleared.
  let current = RANK_THRESHOLDS[0]
  for (const threshold of RANK_THRESHOLDS) {
    if (xp >= threshold.xp) current = threshold
  }
  const next = RANK_THRESHOLDS.find((t) => t.tier === current.tier + 1) ?? null

  return {
    tier: current.tier,
    title: current.title,
    nextTitle: next?.title ?? null,
    xpIntoTier: xp - current.xp,
    xpForNext: next ? next.xp - current.xp : null,
    progress: next ? (xp - current.xp) / (next.xp - current.xp) : 1
  }
}

export function computeServiceRecord(
  companionId: string,
  deployments: Deployment[]
): ServiceRecord {
  const mine = deployments.filter((d) => d.companionId === companionId)

  let completed = 0
  let failed = 0
  let linesChanged = 0
  let filesTouched = 0
  let timeInFieldMs = 0
  let xp = 0

  for (const d of mine) {
    if (d.status !== 'completed' && d.status !== 'failed') continue
    if (d.neverLaunched) continue

    if (d.status === 'completed') {
      completed++
      const ins = d.diffStats?.insertions ?? 0
      const del = d.diffStats?.deletions ?? 0
      linesChanged += ins + del
      filesTouched += d.diffStats?.filesChanged ?? 0
      xp += XP_PER_COMPLETED + Math.min(MAX_LINE_XP_PER_SORTIE, Math.floor((ins + del) / 10))
    } else {
      failed++
      xp += XP_PER_FAILED
    }

    if (d.completedAt !== undefined) {
      // Guard against a corrupt/zombie record where completedAt somehow
      // precedes startedAt — never let a sortie subtract time in the field.
      timeInFieldMs += Math.max(0, d.completedAt - d.startedAt)
    }
  }

  const sorties = completed + failed

  return {
    sorties,
    completed,
    failed,
    successRate: sorties === 0 ? null : completed / sorties,
    linesChanged,
    filesTouched,
    timeInFieldMs,
    xp,
    rank: rankForXp(xp)
  }
}
