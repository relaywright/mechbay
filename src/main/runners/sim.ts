import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import type { AgentFamily } from '../../shared/types'
import { extractTaskPrompt } from '../soul-memory'
import type { Runner, RunnerChunk, SpawnResult } from './types'

interface SimRunnerOptions {
  pacingMs?: number
}

interface AsyncChunkQueue {
  stream: AsyncIterable<RunnerChunk>
  push: (chunk: RunnerChunk) => void
  close: () => void
}

const DEFAULT_PACING_MS = 1_300

const FLAVOR: Record<AgentFamily, { mech: string; boot: string; scan: string; complete: string }> =
  {
    claude: {
      mech: 'Atlas heavy-assault chassis',
      boot: 'ATLAS // reactor online. Holding the center.',
      scan: 'Armor steady. Mapping the facility before committing force.',
      complete: 'Objective secured. Atlas returning under its own power.'
    },
    codex: {
      mech: 'Marauder surgical platform',
      boot: 'MARAUDER // link clean. Target acquired.',
      scan: 'Minimal surface. Precise changes only.',
      complete: 'Patch landed. No wasted motion.'
    },
    kimi: {
      mech: 'Raven reconnaissance frame',
      boot: 'RAVEN // ECM veil raised. Recon channel open.',
      scan: '▸ INTENT: Sweep the tree, mark the quiet signals, then move.',
      complete: '◆ FINDINGS: Mission trail is clean; telemetry confirms the change.'
    },
    gemini: {
      mech: 'Catapult ranged-analysis chassis',
      boot: 'CATAPULT // long-range sensors synchronized.',
      scan: 'Computing parallel trajectories across code, config, and telemetry.',
      complete: 'Analysis converged. Payload delivered on the optimal arc.'
    },
    hermes: {
      mech: 'Locust courier frame',
      boot: 'LOCUST // comms hot, legs hot, route clear.',
      scan: 'Fast pass first. I will carry the useful signal home.',
      complete: 'Package delivered. Already halfway back to the bay.'
    }
  }

function createQueue(): AsyncChunkQueue {
  const buffered: RunnerChunk[] = []
  const waiting: Array<(result: IteratorResult<RunnerChunk>) => void> = []
  let closed = false

  const stream: AsyncIterable<RunnerChunk> = {
    [Symbol.asyncIterator](): AsyncIterator<RunnerChunk> {
      return {
        next(): Promise<IteratorResult<RunnerChunk>> {
          const chunk = buffered.shift()
          if (chunk) return Promise.resolve({ value: chunk, done: false })
          if (closed) return Promise.resolve({ value: undefined, done: true })
          return new Promise((resolve) => waiting.push(resolve))
        }
      }
    }
  }

  return {
    stream,
    push(chunk): void {
      if (closed) return
      const resolve = waiting.shift()
      if (resolve) resolve({ value: chunk, done: false })
      else buffered.push(chunk)
    },
    close(): void {
      if (closed) return
      closed = true
      for (const resolve of waiting.splice(0)) resolve({ value: undefined, done: true })
    }
  }
}

function promptExcerpt(prompt: string): string {
  const compact = prompt.replace(/\s+/g, ' ').trim()
  return compact.length > 60 ? `${compact.slice(0, 60)}…` : compact
}

export class SimRunner implements Runner {
  private readonly family: AgentFamily
  private readonly pacingMs: number

  constructor(family: AgentFamily, opts: SimRunnerOptions = {}) {
    this.family = family
    this.pacingMs = Math.max(0, opts.pacingMs ?? DEFAULT_PACING_MS)
  }

  async isAvailable(): Promise<boolean> {
    return true
  }

  async spawn(cwd: string, prompt: string): Promise<SpawnResult> {
    // Deployments send soul + memory + task; a person should only see the task.
    const task = extractTaskPrompt(prompt)
    const flavor = FLAVOR[this.family]
    const queue = createQueue()
    let timer: ReturnType<typeof setTimeout> | undefined
    let settled = false
    let resolveExit!: (code: number) => void
    const exit = new Promise<number>((resolve) => {
      resolveExit = resolve
    })

    const beats = [
      flavor.boot,
      `ACK // ${flavor.mech} assigned.`,
      `TASK // “${promptExcerpt(task)}”`,
      flavor.scan,
      'SCAN // reading facility manifest...',
      '  -> read_file({ path: "README.md" })',
      'SCAN // tracing reactor-control boundaries...',
      '  -> read_file({ path: "src/reactor-control.ts" })',
      'PLAN // preserve the baseline; leave an auditable mission trail.',
      '  -> write_file({ path: "mission-report.md" })',
      'EDIT // report stamped with task and sortie time.',
      '  -> edit_file({ path: "src/telemetry.ts" })',
      'VERIFY // telemetry calibration marker detected.',
      'DIFF // working tree registers mission changes.',
      'CHECK // no external runtime or credentials engaged.',
      flavor.complete,
      'MISSION COMPLETE // debrief package ready.'
    ]

    const finish = (code: number): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      queue.close()
      resolveExit(code)
    }

    const applyMissionEdits = (): void => {
      const timestamp = new Date().toISOString()
      try {
        mkdirSync(cwd, { recursive: true })
        writeFileSync(
          join(cwd, 'mission-report.md'),
          `# SimRunner Mission Report\n\n- Mech family: ${this.family}\n- Timestamp: ${timestamp}\n\n## Task\n\n${task}\n`,
          'utf8'
        )

        const telemetryPath = join(cwd, 'src', 'telemetry.ts')
        if (existsSync(telemetryPath)) {
          appendFileSync(telemetryPath, `\n// [sim] calibration pass ${timestamp}\n`, 'utf8')
        } else {
          const fieldLogPath = join(cwd, 'notes', 'field-log.txt')
          mkdirSync(dirname(fieldLogPath), { recursive: true })
          writeFileSync(
            fieldLogPath,
            `[${timestamp}] ${this.family} completed simulated field calibration.\n`,
            'utf8'
          )
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        queue.push({ stream: 'stderr', text: `SIM WARNING // file edits failed: ${message}\n` })
      }
    }

    let index = 0
    const advance = (): void => {
      if (settled) return
      if (index === 9) applyMissionEdits()
      if (index >= beats.length) {
        finish(0)
        return
      }
      queue.push({ stream: 'stdout', text: `${beats[index]}\n` })
      index += 1
      timer = setTimeout(advance, this.pacingMs)
    }

    timer = setTimeout(advance, this.pacingMs)

    return {
      stream: queue.stream,
      abort: async () => finish(-1),
      exit
    }
  }
}
