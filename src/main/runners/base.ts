import { spawn as nodeSpawn, ChildProcess } from 'child_process'
import { StringDecoder } from 'string_decoder'
import crossSpawn from 'cross-spawn'
import type { Runner, RunnerSpawnOptions, SpawnResult, RunnerChunk } from './types'
import type { StreamTransform } from './claude-stream'

/**
 * Shared plumbing for CLI-backed runners (Claude/Codex/Kimi/Gemini).
 * cross-spawn resolves Windows .cmd/.bat shims and handles argument
 * escaping; plain child_process.spawn cannot launch npm shims with
 * shell: false. Prompts are delivered through stdin because they combine
 * soul.md, memory.md, and task text: arbitrary content that can exceed
 * Windows' ~32k argv ceiling and would require shell quoting through
 * cmd.exe. stdin avoids both limits while keeping shell: false.
 *
 * HermesRunner doesn't use this base — it runs a non-CLI backend.
 */

export interface CliRunnerDeps {
  which: (cmd: string) => Promise<string | null>
  spawnProcess?: typeof nodeSpawn
  /** Defaults to process.platform. Lets tests pin Windows-only flags. */
  platform?: NodeJS.Platform
  /** Extra argv a runner inserts before its model flag. Used by acceptance tests to ignore the user's own CLI config. */
  profileArgs?: string[]
}

export async function defaultWhich(cmd: string): Promise<string | null> {
  return new Promise((resolve) => {
    const checker = nodeSpawn(process.platform === 'win32' ? 'where.exe' : 'which', [cmd])
    let out = ''
    checker.stdout?.on('data', (d) => (out += d.toString()))
    checker.on('exit', (code) => resolve(code === 0 ? out.trim().split(/\r?\n/)[0] : null))
    checker.on('error', () => resolve(null))
  })
}

export abstract class CliRunner implements Runner {
  protected which: (cmd: string) => Promise<string | null>
  protected spawnProcess: typeof nodeSpawn
  protected platform: NodeJS.Platform
  protected profileArgs: string[]

  constructor(deps: Partial<CliRunnerDeps> = {}) {
    this.which = deps.which ?? defaultWhich
    this.spawnProcess = deps.spawnProcess ?? (crossSpawn as typeof nodeSpawn)
    this.platform = deps.platform ?? process.platform
    this.profileArgs = deps.profileArgs ?? []
  }

  /** The executable to look up on PATH and invoke. */
  protected abstract command: string
  /** Turn a user prompt and the spawn options (model, Autonomy level) into argv for the CLI. */
  protected abstract buildArgs(prompt: string, options: RunnerSpawnOptions): string[]
  /**
   * Optionally pipe content to the child's stdin and close it.
   * Default: no stdin writes — the runner relies purely on argv.
   * Override to return the prompt string (or a derived payload) when
   * argv is impractical (e.g. multi-KB prompts that risk the Windows
   * ~32k argv ceiling, or a CLI that only accepts stdin).
   */
  protected stdinInput(_prompt: string): string | null {
    return null
  }

  /** Rewrite stdout before it reaches the log (for CLIs that print structured events). */
  protected createStdoutTransform(): StreamTransform | null {
    return null
  }

  async isAvailable(): Promise<boolean> {
    return (await this.which(this.command)) !== null
  }

  async spawn(cwd: string, prompt: string, options?: RunnerSpawnOptions): Promise<SpawnResult> {
    const spawnOptions = {
      cwd,
      shell: false,
      ...(options?.env ? { env: { ...process.env, ...options.env } } : {})
    }
    const child = this.spawnProcess(
      this.command,
      this.buildArgs(prompt, options ?? {}),
      spawnOptions
    )

    const stdinPayload = this.stdinInput(prompt)
    if (stdinPayload !== null && child.stdin) {
      // EPIPE can fire if the child exits before we finish writing
      // (ENOENT, permission error, immediate crash). Swallow silently —
      // the child's exit/error events will surface the real failure
      // through the stream already.
      child.stdin.on('error', () => {})
      try {
        child.stdin.write(stdinPayload)
        child.stdin.end()
      } catch {
        /* already closed */
      }
    }

    let aborted = false
    const abort = (): void => {
      // `child.exitCode == null` covers both `null` (Node's "not yet
      // exited" value) and `undefined` (mock children in tests).
      if (aborted || child.killed || child.exitCode != null) return
      aborted = true
      try {
        child.kill('SIGTERM')
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        if (!child.killed && child.exitCode === null) {
          try {
            child.kill('SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }, 5000).unref()
    }

    const exit = new Promise<number>((resolve) => {
      child.on('exit', (code) => resolve(code ?? -1))
      child.on('error', () => resolve(-1))
    })

    const transform = this.createStdoutTransform()
    return {
      stream: this.toAsyncStream(child, transform),
      abort,
      exit,
      ...(transform ? { report: () => transform.report() } : {})
    }
  }

  private async *toAsyncStream(
    child: ChildProcess,
    transform: StreamTransform | null
  ): AsyncIterable<RunnerChunk> {
    const queue: RunnerChunk[] = []
    let resolveNext: (() => void) | null = null
    let done = false

    const wake = (): void => {
      const r = resolveNext
      resolveNext = null
      r?.()
    }

    // One decoder per stream, so a multi-byte character split across two
    // chunks is not garbled.
    const outDecoder = new StringDecoder('utf8')
    const errDecoder = new StringDecoder('utf8')

    const pushStdout = (text: string): void => {
      const shown = transform ? transform.push(text) : text
      if (shown) queue.push({ stream: 'stdout', text: shown })
    }

    child.stdout?.on('data', (d: Buffer) => {
      pushStdout(outDecoder.write(d))
      wake()
    })
    child.stdout?.on('error', (err) => {
      queue.push({ stream: 'stderr', text: `[stream error] ${err.message}\n` })
      done = true
      wake()
    })
    child.stderr?.on('data', (d: Buffer) => {
      const text = errDecoder.write(d)
      if (text) queue.push({ stream: 'stderr', text })
      wake()
    })
    child.stderr?.on('error', (err) => {
      queue.push({ stream: 'stderr', text: `[stream error] ${err.message}\n` })
      done = true
      wake()
    })
    child.on('close', () => {
      pushStdout(outDecoder.end())
      if (transform) {
        const tail = transform.end()
        if (tail) queue.push({ stream: 'stdout', text: tail })
      }
      const errTail = errDecoder.end()
      if (errTail) queue.push({ stream: 'stderr', text: errTail })
      done = true
      wake()
    })
    child.on('error', (err) => {
      queue.push({ stream: 'stderr', text: `[spawn error] ${err.message}\n` })
      done = true
      wake()
    })

    while (!done || queue.length > 0) {
      while (queue.length > 0) yield queue.shift()!
      if (done) break
      await new Promise<void>((r) => (resolveNext = r))
    }
  }
}
