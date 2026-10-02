import { vi } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { StoreLike } from '../../src/main/state-manager'
import type {
  Runner,
  RunnerChunk,
  RunnerSpawnOptions,
  SpawnResult
} from '../../src/main/runners/types'
import type { AgentFamily } from '../../src/shared/types'

export function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (key: string) => data[key],
    set: (key: string, value: unknown) => {
      data[key] = value
    },
    has: (key: string) => key in data
  }
}

export function makeFakeWin(): BrowserWindow {
  return { isDestroyed: () => false, webContents: { send: vi.fn() } } as unknown as BrowserWindow
}

export const fakeFsReader = {
  readDir: vi.fn(),
  readFile: vi.fn(),
  updateWhitelist: vi.fn()
} as never

export interface ControlledRun {
  cwd: string
  prompt: string
  options: RunnerSpawnOptions | undefined
  finish: (code: number) => void
  aborted: boolean
}

/**
 * A runner whose missions run until the test finishes them. With
 * `ignoreAbort`, abort only records the call and the "process" keeps running
 * until the test finishes it, to model an agent that exits late.
 */
export function controllableRunner(
  options: { failSpawn?: (prompt: string) => boolean; ignoreAbort?: boolean } = {}
): {
  runner: Runner
  runs: ControlledRun[]
} {
  const runs: ControlledRun[] = []
  const runner: Runner = {
    isAvailable: async () => true,
    spawn: async (cwd, prompt, spawnOptions): Promise<SpawnResult> => {
      if (options.failSpawn?.(prompt)) throw new Error('spawn ENOENT')
      let finish!: (code: number) => void
      const exit = new Promise<number>((resolve) => (finish = resolve))
      const run: ControlledRun = { cwd, prompt, options: spawnOptions, finish, aborted: false }
      runs.push(run)
      // No output; the stream ends when the test finishes the mission.
      async function* stream(): AsyncGenerator<RunnerChunk> {
        await exit
        yield* []
      }
      return {
        stream: stream(),
        exit,
        abort: async () => {
          run.aborted = true
          if (!options.ignoreAbort) finish(-1)
        }
      }
    }
  }
  return { runner, runs }
}

export function runnersFor(runner: Runner): Record<AgentFamily, Runner> {
  return Object.fromEntries(
    (['claude', 'codex', 'kimi', 'gemini', 'hermes'] as AgentFamily[]).map((f) => [f, runner])
  ) as Record<AgentFamily, Runner>
}
