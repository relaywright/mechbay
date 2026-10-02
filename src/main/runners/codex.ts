import { CliRunner } from './base'
import type { RunnerSpawnOptions } from './types'
import { DEFAULT_AUTONOMY, type AutonomyLevel } from '../../shared/autonomy'

const SANDBOX: Record<AutonomyLevel, string> = {
  read: 'read-only',
  edit: 'workspace-write',
  full: 'danger-full-access'
}

/**
 * OpenAI Codex CLI, invoked as
 * `codex exec --sandbox <mode> --skip-git-repo-check [-c windows.sandbox=unelevated] [-m <model>] -`
 * with the prompt piped through stdin. `exec` is the non-interactive entry
 * point and the trailing `-` selects stdin. MechBay buildings need not be
 * git repos, hence `--skip-git-repo-check`. On Windows the unelevated
 * sandbox is passed explicitly: without it, a config that does not set
 * windows.sandbox runs workspace-write as read-only.
 */
export class CodexRunner extends CliRunner {
  protected command = 'codex'
  protected buildArgs(_prompt: string, options: RunnerSpawnOptions): string[] {
    return [
      'exec',
      '--sandbox',
      SANDBOX[options.autonomy ?? DEFAULT_AUTONOMY],
      '--skip-git-repo-check',
      ...(this.platform === 'win32' ? ['-c', 'windows.sandbox=unelevated'] : []),
      ...this.profileArgs,
      ...(options.model ? ['-m', options.model] : []),
      '-'
    ]
  }

  protected stdinInput(prompt: string): string | null {
    return prompt
  }
}
