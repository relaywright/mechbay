import * as nodeFs from 'fs'
import path from 'path'
import { MAX_SAVED_MISSIONS } from '../shared/defaults'
import type { LogChunk } from '../shared/types'
import type { StateManager } from './state-manager'
import type { LogChunkV2 } from './state-migrations'

/**
 * Mission logs on disk (P0-13), outside saved state: one append-only JSONL
 * file per mission. Lines are buffered and written in batches so a chatty
 * agent costs one disk write per batch, not one per line. A disk problem
 * never stops a mission: the live view keeps every line and shows one
 * warning; only the saved copy is affected.
 *
 * Text must already be redacted when it reaches `append`: everything
 * appended goes to the renderer and to disk as is.
 */

export interface LogInput {
  stream: LogChunk['stream']
  text: string
  thoughtKind?: 'intent' | 'findings'
}

export interface MissionLogSink {
  append(missionId: string, entry: LogInput): void
  /** Flush and forget a mission's buffer. Call once the mission has ended. */
  close(missionId: string): void
}

type LogFs = Pick<
  typeof nodeFs,
  | 'appendFileSync'
  | 'existsSync'
  | 'lstatSync'
  | 'mkdirSync'
  | 'readFileSync'
  | 'readdirSync'
  | 'renameSync'
  | 'unlinkSync'
  | 'writeFileSync'
>

export interface LogStoreOptions {
  dir: string
  fs?: LogFs
  flushLines?: number
  flushMs?: number
  maxLinesPerMission?: number
  historyLimit?: number
  /** Receives every flushed batch, including warnings that are never saved. */
  onEntries?: (entries: LogChunk[]) => void
  now?: () => number
}

const MISSION_ID = /^[0-9A-Za-z_-]{1,64}$/
/** Names Windows maps to devices whatever the extension (`CON.jsonl` is the console). */
const WINDOWS_DEVICE = /^(con|prn|aux|nul|com\d|lpt\d|conin\$|conout\$)$/i
const LOG_EXT = '.jsonl'
/** One line longer than this (a minified bundle, say) is shortened before it is saved or shown. */
const MAX_LINE_CHARS = 16_384
const SHORTENED = ' ... [line shortened]'

function capLine(text: string): string {
  if (text.length <= MAX_LINE_CHARS) return text
  let end = MAX_LINE_CHARS
  // Never leave half of a surrogate pair (an emoji) at the cut.
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end -= 1
  return text.slice(0, end) + SHORTENED
}

/**
 * Mission ids arrive from the renderer (`logs.history`), so this is the
 * gate between a string and a file path: letters, digits, `_` and `-` only
 * (no separators, dots or drive letters), and never a Windows device name.
 */
export function isValidMissionId(id: string): boolean {
  return typeof id === 'string' && MISSION_ID.test(id) && !WINDOWS_DEVICE.test(id)
}

const LOG_STREAMS: ReadonlySet<string> = new Set(['stdout', 'stderr', 'system', 'thought'])

function isLegacyChunk(value: unknown): value is LogChunkV2 {
  if (typeof value !== 'object' || value === null) return false
  const c = value as Record<string, unknown>
  return (
    typeof c.deploymentId === 'string' &&
    isValidMissionId(c.deploymentId) &&
    typeof c.text === 'string' &&
    typeof c.timestamp === 'number' &&
    Number.isFinite(c.timestamp) &&
    typeof c.stream === 'string' &&
    LOG_STREAMS.has(c.stream)
  )
}

/** Demo and real bays share userData; their logs must not mix. */
export function logDirFor(userData: string, demo: boolean): string {
  return path.join(userData, 'mechbay', demo ? 'logs-demo' : 'logs')
}

interface MissionBuffer {
  seq: number
  pending: LogChunk[]
  savedLines: number
  timer: ReturnType<typeof setTimeout> | null
  saving: boolean
  truncated: boolean
  /** The saved file ends in a line cut off mid-write; start the next write on a new line. */
  needsNewline: boolean
}

export class LogStore implements MissionLogSink {
  private readonly dir: string
  private readonly fs: LogFs
  private readonly flushLines: number
  private readonly flushMs: number
  private readonly maxLines: number
  private readonly historyLimit: number
  private readonly onEntries?: (entries: LogChunk[]) => void
  private readonly now: () => number
  private readonly missions = new Map<string, MissionBuffer>()

  constructor(options: LogStoreOptions) {
    this.dir = path.resolve(options.dir)
    this.fs = options.fs ?? nodeFs
    this.flushLines = options.flushLines ?? 50
    this.flushMs = options.flushMs ?? 200
    this.maxLines = options.maxLinesPerMission ?? 20_000
    this.historyLimit = options.historyLimit ?? 2_000
    this.onEntries = options.onEntries
    this.now = options.now ?? Date.now
  }

  append(missionId: string, input: LogInput): void {
    const mission = this.mission(missionId)
    mission.seq += 1
    mission.pending.push({
      id: `${missionId}:${mission.seq}`,
      deploymentId: missionId,
      seq: mission.seq,
      timestamp: this.now(),
      stream: input.stream,
      text: capLine(input.text),
      ...(input.thoughtKind ? { thoughtKind: input.thoughtKind } : {})
    })
    if (mission.pending.length >= this.flushLines) this.flush(missionId)
    else if (!mission.timer) {
      mission.timer = setTimeout(() => this.flush(missionId), this.flushMs)
      mission.timer.unref?.()
    }
  }

  close(missionId: string): void {
    if (!this.missions.has(missionId)) return
    this.flush(missionId)
    this.missions.delete(missionId)
  }

  flushAll(): void {
    for (const id of [...this.missions.keys()]) this.flush(id)
  }

  async history(missionId: string, afterSeq = 0): Promise<LogChunk[]> {
    const file = this.fileFor(missionId)
    const saved = this.readSaved(file)
    const savedSeqs = new Set(saved.map((e) => e.seq))
    const pending = (this.missions.get(missionId)?.pending ?? []).filter(
      (e) => !savedSeqs.has(e.seq)
    )
    return [...saved, ...pending].filter((e) => e.seq > afterSeq).slice(-this.historyLimit)
  }

  /**
   * Delete log files of missions not in `keepIds`. Returns how many were
   * removed. Only plain files named `<mission id>.jsonl` directly inside the
   * log folder are candidates: links, folders and anything else are left
   * alone, and nothing happens when the log folder itself is a link.
   */
  prune(keepIds: Iterable<string>): number {
    if (!this.isRealDir(this.dir)) return 0
    const keep = new Set(keepIds)
    let names: string[]
    try {
      names = this.fs.readdirSync(this.dir)
    } catch (err) {
      console.warn('[log-store] could not list the log folder; nothing pruned:', err)
      return 0
    }
    let removed = 0
    for (const name of names) {
      if (!name.endsWith(LOG_EXT)) continue
      const id = name.slice(0, -LOG_EXT.length)
      if (!isValidMissionId(id) || keep.has(id) || this.missions.has(id)) continue
      const file = path.join(this.dir, name)
      try {
        // lstat, not stat: a link named like a log is never followed or removed.
        if (!this.fs.lstatSync(file).isFile()) continue
        this.fs.unlinkSync(file)
        removed++
      } catch (err) {
        console.warn(`[log-store] could not remove ${name}:`, err)
      }
    }
    return removed
  }

  /**
   * Move schema 2 log chunks into files. Skips a mission whose file already
   * exists, and any chunk a hand-edited or damaged save left malformed.
   * v1.4.0 saved lines before redaction existed, so each one goes through
   * `redact` on the way in.
   */
  importLegacy(chunks: LogChunkV2[], redact: (text: string) => string = (text) => text): number {
    const byMission = new Map<string, LogChunkV2[]>()
    for (const chunk of chunks as unknown[]) {
      if (!isLegacyChunk(chunk)) continue
      const list = byMission.get(chunk.deploymentId) ?? []
      list.push(chunk)
      byMission.set(chunk.deploymentId, list)
    }
    let imported = 0
    for (const [missionId, list] of byMission) {
      const file = this.fileFor(missionId)
      if (this.fs.existsSync(file)) continue
      const lines = [...list]
        .sort((a, b) => a.timestamp - b.timestamp)
        .map((c, i): LogChunk => ({
          id: `${missionId}:${i + 1}`,
          deploymentId: missionId,
          seq: i + 1,
          timestamp: c.timestamp,
          stream: c.stream,
          text: capLine(redact(c.text)),
          ...(c.thoughtKind === 'intent' || c.thoughtKind === 'findings'
            ? { thoughtKind: c.thoughtKind }
            : {})
        }))
      try {
        this.ensureDir()
        // Write aside, then rename: a crash mid-import leaves only a .tmp
        // file, never a half log that the existence check above would
        // later mistake for a finished import.
        const tmp = `${file}.tmp`
        const data = lines.map((l) => JSON.stringify(l)).join('\n') + '\n'
        this.fs.writeFileSync(tmp, data)
        try {
          this.fs.renameSync(tmp, file)
        } catch (err) {
          // Antivirus or the search indexer can hold a just-written file on
          // Windows. Write the log directly instead ('wx': never over a log
          // that appeared meanwhile) and drop the temporary copy.
          console.warn(`[log-store] rename refused for ${missionId}; writing directly:`, err)
          this.fs.writeFileSync(file, data, { flag: 'wx' })
          try {
            this.fs.unlinkSync(tmp)
          } catch (unlinkErr) {
            console.warn(`[log-store] could not remove ${path.basename(tmp)}:`, unlinkErr)
          }
        }
        imported += lines.length
      } catch (err) {
        console.warn(`[log-store] could not import logs for ${missionId}:`, err)
      }
    }
    return imported
  }

  private mission(missionId: string): MissionBuffer {
    const file = this.fileFor(missionId)
    let mission = this.missions.get(missionId)
    if (!mission) {
      mission = {
        seq: 0,
        pending: [],
        savedLines: 0,
        timer: null,
        saving: true,
        truncated: false,
        needsNewline: false
      }
      try {
        const { entries: saved, cutOff } = this.readSavedFile(file)
        mission.seq = saved.at(-1)?.seq ?? 0
        mission.savedLines = saved.length
        mission.needsNewline = cutOff
      } catch (err) {
        // The saved log exists but cannot be read (locked, permissions).
        // Appending blind could repeat sequence numbers, so show this
        // mission live only.
        mission.saving = false
        mission.seq += 1
        mission.pending.push(this.notSavedLine(missionId, mission.seq, err))
        console.error(`[log-store] could not read the saved log for ${missionId}:`, err)
      }
      this.missions.set(missionId, mission)
    }
    return mission
  }

  private flush(missionId: string): void {
    const mission = this.missions.get(missionId)
    if (!mission) return
    if (mission.timer) clearTimeout(mission.timer)
    mission.timer = null
    if (mission.pending.length === 0) return
    const batch = mission.pending
    mission.pending = []
    const live = [...batch]

    if (mission.saving) {
      const room = Math.max(0, this.maxLines - mission.savedLines)
      const toSave = batch.slice(0, room)
      if (toSave.length < batch.length && !mission.truncated) {
        mission.truncated = true
        mission.seq += 1
        const marker = this.systemLine(
          missionId,
          mission.seq,
          `LOG TRUNCATED · This mission passed ${this.maxLines.toLocaleString('en-US')} lines. Later lines show live but are not saved.`
        )
        toSave.push(marker)
        live.push(marker)
      }
      try {
        if (toSave.length > 0) {
          this.ensureDir()
          this.fs.appendFileSync(
            this.fileFor(missionId),
            (mission.needsNewline ? '\n' : '') +
              toSave.map((e) => JSON.stringify(e)).join('\n') +
              '\n'
          )
          mission.needsNewline = false
          mission.savedLines += toSave.length
        }
        if (mission.truncated) mission.saving = false
      } catch (err) {
        mission.saving = false
        mission.seq += 1
        live.push(this.notSavedLine(missionId, mission.seq, err))
        console.error(`[log-store] write failed for ${missionId}:`, err)
      }
    }
    this.onEntries?.(live)
  }

  private notSavedLine(missionId: string, seq: number, err: unknown): LogChunk {
    const reason =
      err instanceof Error ? ((err as NodeJS.ErrnoException).code ?? err.message) : String(err)
    return this.systemLine(
      missionId,
      seq,
      `LOG NOT SAVED · ${reason}. The mission keeps running, but this log will not survive a restart.`
    )
  }

  private systemLine(missionId: string, seq: number, text: string): LogChunk {
    return {
      id: `${missionId}:${seq}`,
      deploymentId: missionId,
      seq,
      timestamp: this.now(),
      stream: 'system',
      text
    }
  }

  private readSaved(file: string): LogChunk[] {
    return this.readSavedFile(file).entries
  }

  private readSavedFile(file: string): { entries: LogChunk[]; cutOff: boolean } {
    if (!this.fs.existsSync(file)) return { entries: [], cutOff: false }
    const raw = this.fs.readFileSync(file, 'utf8')
    const entries: LogChunk[] = []
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue
      try {
        entries.push(JSON.parse(line) as LogChunk)
      } catch {
        // A line cut short by a crash mid-write: skip it, keep the rest.
      }
    }
    return { entries, cutOff: raw.length > 0 && !raw.endsWith('\n') }
  }

  /** The only place a mission id becomes a path. Throws for any id that is not a plain name. */
  private fileFor(missionId: string): string {
    if (!isValidMissionId(missionId)) throw new Error('Invalid mission id')
    const file = path.join(this.dir, `${missionId}${LOG_EXT}`)
    // Defense in depth: the id check above already rules out separators and dots.
    if (path.dirname(file) !== this.dir) throw new Error('Invalid mission id')
    return file
  }

  private isRealDir(dir: string): boolean {
    try {
      const stat = this.fs.lstatSync(dir)
      return stat.isDirectory() && !stat.isSymbolicLink()
    } catch {
      return false
    }
  }

  private ensureDir(): void {
    this.fs.mkdirSync(this.dir, { recursive: true })
  }
}

/**
 * Startup: move schema 2 logs into files, then delete logs of missions that
 * left saved history. A mission leaves history only when a full history
 * (MAX_SAVED_MISSIONS) drops its oldest, so pruning waits until the history
 * is full. A bay started fresh after a damaged save, or reset by hand, has
 * few missions for many launches; pruning it would delete the logs of a
 * save the player may still restore. Never prunes while the saved bay is
 * read-only or was started fresh this session.
 */
export function prepareLogStore(
  logs: LogStore,
  state: Pick<StateManager, 'getHealth' | 'getState' | 'startedFresh' | 'takeLegacyLogChunks'>,
  options: { redact?: (text: string) => string } = {}
): void {
  const legacy = state.takeLegacyLogChunks()
  if (legacy.length) {
    console.info(
      `[log-store] moved ${logs.importLegacy(legacy, options.redact)} saved log lines out of the state file`
    )
  }
  if (!state.getHealth().ok || state.startedFresh()) return
  const deployments = state.getState().deployments
  if (deployments.length < MAX_SAVED_MISSIONS) return
  const removed = logs.prune(deployments.map((d) => d.id))
  if (removed) console.info(`[log-store] removed ${removed} logs of missions no longer in history`)
}
