import { CliRunner, type CliRunnerDeps } from './base'
import type { SecretsManager } from '../secrets'

export interface KimiRunnerDeps extends Partial<CliRunnerDeps> {
  /**
   * Absolute path to `kimi_fireworks.py` bundled with the app.
   * Resolved at boot in src/main/index.ts via `app.getAppPath()`.
   */
  scriptPath: string
  secrets?: Pick<SecretsManager, 'getStatus'>
}

/**
 * Moonshot Kimi via the Fireworks AI API — invoked as:
 *   python <scriptPath> - -v --narrate
 *
 * The prompt is piped via stdin (the trailing `-` argument tells the
 * wrapper to read from stdin). The `-v` flag emits tool-call lines to
 * stderr for the LIVE LOG panel. `--narrate` instructs Kimi to produce
 * `[INTENT]` lines before tool calls and `[FINDINGS]` reflections at
 * subtask boundaries so NarrationParser can render them as thought
 * cards.
 *
 * Why Fireworks and not the native `kimi` CLI:
 *   1. Uncapped usage vs. the native CLI's membership-gated quota.
 *   2. Full agentic loop with 9 baked-in tools (read_file, edit_file,
 *      run_command, grep, etc.) — exactly what the deploy-into-facility
 *      flow needs, no extra wiring in the renderer.
 *   3. The prompt Kimi sees is assembled from soul.md + memory.md + task
 *      which can exceed the Windows argv ceiling; stdin sidesteps that.
 *
 * Auth comes from FIREWORKS_API_KEY: either the environment or a key stored
 * in MechBay Settings (encrypted by the OS and injected into this process at
 * launch).
 */
export class KimiRunner extends CliRunner {
  protected command = 'python'
  private scriptPath: string
  private secrets?: Pick<SecretsManager, 'getStatus'>

  constructor(deps: KimiRunnerDeps) {
    super(deps)
    this.scriptPath = deps.scriptPath
    this.secrets = deps.secrets
  }

  // A Python-only probe would mark Raven-Prime deployable when the wrapper will fail authentication.
  async isAvailable(): Promise<boolean> {
    const pythonPath = await this.which(this.command)
    const hasKey =
      (this.secrets?.getStatus().kimi ?? false) || Boolean(process.env.FIREWORKS_API_KEY)
    return pythonPath !== null && hasKey
  }

  protected buildArgs(_prompt: string, model?: string): string[] {
    return [this.scriptPath, '-', '-v', '--narrate', ...(model ? ['--model', model] : [])]
  }

  protected stdinInput(prompt: string): string | null {
    return prompt
  }
}
