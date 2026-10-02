import type { LogChunk } from '../../src/shared/types'
import type { LogInput, MissionLogSink } from '../../src/main/log-store'

/** In-memory MissionLogSink for IPC tests. `entries` collects everything appended. */
export function makeLogSink(): {
  sink: MissionLogSink & { history: (id: string, afterSeq?: number) => Promise<LogChunk[]> }
  entries: LogChunk[]
  closed: string[]
} {
  const entries: LogChunk[] = []
  const closed: string[] = []
  const seqs = new Map<string, number>()
  return {
    entries,
    closed,
    sink: {
      append(missionId: string, entry: LogInput): void {
        const seq = (seqs.get(missionId) ?? 0) + 1
        seqs.set(missionId, seq)
        entries.push({
          id: `${missionId}:${seq}`,
          deploymentId: missionId,
          seq,
          timestamp: Date.now(),
          ...entry
        })
      },
      close(missionId: string): void {
        closed.push(missionId)
      },
      history: async (id: string, afterSeq = 0) =>
        entries.filter((e) => e.deploymentId === id && e.seq > afterSeq)
    }
  }
}
