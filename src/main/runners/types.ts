/**
 * Common contract every agent-family runner implements.
 *
 * Runners are the boundary between MechBay and the actual CLI processes.
 * Each agent family (claude, codex, kimi, gemini, hermes) gets its own
 * runner file under src/main/runners/<family>.ts. Adding a new family
 * is a drop-in: implement `Runner`, register in the runner map.
 */

import type { RunReport } from './claude-stream'
import type { AutonomyLevel } from '../../shared/autonomy'

export interface RunnerChunk {
  stream: 'stdout' | 'stderr'
  text: string
}

export interface SpawnResult {
  /** Async iterable of stdout/stderr chunks. Yields until the child exits. */
  stream: AsyncIterable<RunnerChunk>
  /** End the agent and every process it started. Safe to call more than once; resolves when done. */
  abort: () => Promise<void>
  /** OS process id of the launched child, when known. */
  pid?: number
  /** Resolves with the child's exit code (or -1 if killed by signal). */
  exit: Promise<number>
  /** Facts the runner learned from the CLI's output (Claude only today). Read after the stream ends. */
  report?: () => RunReport
}

/** Optional per-spawn overrides threaded through to the runner's argv. */
export interface RunnerSpawnOptions {
  /** Model override passed to the runtime CLI, if it supports one. */
  model?: string
  /** Environment variables injected into this process only. */
  env?: Record<string, string>
  /** Permission level; each runner maps it to its CLI's own flags. Defaults to DEFAULT_AUTONOMY. */
  autonomy?: AutonomyLevel
}

export interface Runner {
  /** Check whether the underlying CLI is available on PATH. */
  isAvailable(): Promise<boolean>

  /** Spawn the CLI with the given cwd + prompt. Returns streams + lifecycle. */
  spawn(cwd: string, prompt: string, options?: RunnerSpawnOptions): Promise<SpawnResult>
}
