import fs from 'fs'
import path from 'path'
import os from 'os'
import type { MechClass } from '../shared/types'
import { defaultSoul, defaultMemory, SOUL_NOT_FOUND } from '../shared/defaults'

export interface SoulMemoryPaths {
  soulPath: string
  memoryPath: string
}

/**
 * Idempotent: creates soul.md + memory.md from templates if they don't
 * exist, but never overwrites a file the user has already edited. Called
 * on boot for every companion so the files are guaranteed to exist before
 * any deploy tries to read them.
 */
export function scaffoldSoulAndMemory(
  mechClass: MechClass,
  name: string,
  paths: SoulMemoryPaths
): void {
  fs.mkdirSync(path.dirname(paths.soulPath), { recursive: true })
  fs.mkdirSync(path.dirname(paths.memoryPath), { recursive: true })
  if (!fs.existsSync(paths.soulPath)) fs.writeFileSync(paths.soulPath, defaultSoul(mechClass))
  if (!fs.existsSync(paths.memoryPath)) fs.writeFileSync(paths.memoryPath, defaultMemory(name))
}

/** Separator between the soul/memory preamble and the task in an assembled prompt. */
const TASK_SEPARATOR = '\n---\n\n# Current Task\n\n'

export function assembleSystemPrompt(
  name: string,
  paths: SoulMemoryPaths,
  taskPrompt: string
): string {
  if (!fs.existsSync(paths.soulPath) || !fs.existsSync(paths.memoryPath)) {
    throw new Error(
      `soul/memory missing for ${name}. Call scaffoldSoulAndMemory first (soulPath=${paths.soulPath})`
    )
  }
  const soul = fs.readFileSync(paths.soulPath, 'utf-8')
  const memory = fs.readFileSync(paths.memoryPath, 'utf-8')
  return `# ${name} · Soul\n\n${soul}\n\n# ${name} · Memory\n\n${memory}\n${TASK_SEPARATOR}${taskPrompt}\n`
}

/**
 * Recovers the task text from a prompt built by assembleSystemPrompt, for
 * places that show the task to a person (sim log, mission report). It uses
 * the first separator, so a task that itself contains "# Current Task"
 * survives whole. A prompt without the separator is returned trimmed.
 */
export function extractTaskPrompt(prompt: string): string {
  const at = prompt.indexOf(TASK_SEPARATOR)
  return (at === -1 ? prompt : prompt.slice(at + TASK_SEPARATOR.length)).trim()
}

export interface MemoryEntry {
  timestamp: Date
  facility: string
  task: string
  outcome: string
}

export function appendMemoryEntry(memoryPath: string, entry: MemoryEntry): void {
  const ts = entry.timestamp.toISOString().replace('T', ' ').slice(0, 16)
  // One line per heading: a multi-line task would break the markdown, and a
  // task quoting TASK_SEPARATOR would make extractTaskPrompt cut inside memory.
  const task = entry.task.replace(/\s*\r?\n\s*/g, ' ').trim()
  const block = `\n## ${ts} · ${entry.facility} · "${task}"\n${entry.outcome}\n`
  fs.appendFileSync(memoryPath, block)
}

// Result types for read/write operations
export type ReadResult = { ok: true; content: string } | { ok: false; error: string }

export type WriteResult = { ok: true } | { ok: false; error: string }

/** Companion IDs are ULIDs today; this allows any plain ID but never a path. */
const COMPANION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

const UNKNOWN_MECH = 'Unknown mech.'

/**
 * Resolve the barracks directory for a companion.
 * Uses userDataDir from state-manager pattern (default: homedir).
 * Returns null for an ID that is not a plain ID or that would resolve
 * outside <base>/mechbay/companions, so a renderer-supplied ID can never
 * point a journal read or write somewhere else on disk.
 */
function resolveCompanionDir(companionId: string, userDataDir?: string): string | null {
  if (typeof companionId !== 'string' || !COMPANION_ID_PATTERN.test(companionId)) return null
  const companionsRoot = path.resolve(userDataDir ?? os.homedir(), 'mechbay', 'companions')
  const companionDir = path.resolve(companionsRoot, companionId)
  if (path.dirname(companionDir) !== companionsRoot) return null
  return companionDir
}

/**
 * Read the soul.md file for a companion.
 * Returns { ok: true, content } on success, { ok: false, error } on failure.
 */
export function readSoul(companionId: string, userDataDir?: string): ReadResult {
  try {
    const companionDir = resolveCompanionDir(companionId, userDataDir)
    if (!companionDir) return { ok: false, error: UNKNOWN_MECH }
    const soulPath = path.join(companionDir, 'soul.md')

    if (!fs.existsSync(soulPath)) {
      return { ok: false, error: `${SOUL_NOT_FOUND} for companion ${companionId}` }
    }

    const content = fs.readFileSync(soulPath, 'utf-8')
    return { ok: true, content }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to read soul.md: ${message}` }
  }
}

/**
 * Write content to the soul.md file for a companion.
 * Creates parent directories if needed.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export function writeSoul(companionId: string, content: string, userDataDir?: string): WriteResult {
  try {
    const companionDir = resolveCompanionDir(companionId, userDataDir)
    if (!companionDir) return { ok: false, error: UNKNOWN_MECH }
    const soulPath = path.join(companionDir, 'soul.md')

    fs.mkdirSync(companionDir, { recursive: true })
    fs.writeFileSync(soulPath, content, 'utf-8')

    return { ok: true }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to write soul.md: ${message}` }
  }
}

/**
 * Read the memory.md file for a companion.
 * Returns { ok: true, content } on success, { ok: false, error } on failure.
 */
export function readMemory(companionId: string, userDataDir?: string): ReadResult {
  try {
    const companionDir = resolveCompanionDir(companionId, userDataDir)
    if (!companionDir) return { ok: false, error: UNKNOWN_MECH }
    const memoryPath = path.join(companionDir, 'memory.md')

    if (!fs.existsSync(memoryPath)) {
      return { ok: false, error: `memory.md not found for companion ${companionId}` }
    }

    const content = fs.readFileSync(memoryPath, 'utf-8')
    return { ok: true, content }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err)
    return { ok: false, error: `Failed to read memory.md: ${message}` }
  }
}
