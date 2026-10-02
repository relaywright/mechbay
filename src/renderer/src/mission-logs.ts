import { useEffect, useRef, useState } from 'react'
import type { Deployment, LogChunk } from '../../shared/types'

const LIVE_CAP = 2000
const HISTORY_MISSIONS = 5

export function compareLogChunks(a: LogChunk, b: LogChunk): number {
  return a.timestamp - b.timestamp || a.deploymentId.localeCompare(b.deploymentId) || a.seq - b.seq
}

/** Add entries, ignoring ones already present (history and live overlap), and keep the newest `cap`. */
export function mergeLogChunks(
  current: LogChunk[],
  incoming: LogChunk[],
  cap = LIVE_CAP
): LogChunk[] {
  const seen = new Set(current.map((e) => e.id))
  const added = incoming.filter((e) => !seen.has(e.id) && seen.add(e.id))
  if (added.length === 0) return current
  return [...current, ...added].sort(compareLogChunks).slice(-cap)
}

/**
 * Live log entries plus saved history for the most recent missions.
 * Subscribes first and fetches history second, so a line written in
 * between arrives through one path or the other (duplicates are dropped).
 */
export function useMissionLogs(deployments: Deployment[]): LogChunk[] {
  const [logs, setLogs] = useState<LogChunk[]>([])
  const fetched = useRef(new Set<string>())

  useEffect(
    () =>
      window.mechbay.logs.subscribe((entries) => setLogs((cur) => mergeLogChunks(cur, entries))),
    []
  )

  const recentIds = [...deployments]
    .sort((a, b) => b.startedAt - a.startedAt)
    .slice(0, HISTORY_MISSIONS)
    .map((d) => d.id)
  const key = recentIds.join(',')

  useEffect(() => {
    for (const id of recentIds) {
      if (fetched.current.has(id)) continue
      fetched.current.add(id)
      window.mechbay.logs
        .history(id)
        .then((entries) => setLogs((cur) => mergeLogChunks(cur, entries)))
        .catch((err) => console.error('[mission-logs] history failed', id, err))
    }
    // recentIds is derived from key
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return logs
}
