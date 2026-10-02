import { CliRunner } from './base'
import { ClaudeStreamFormatter, type StreamTransform } from './claude-stream'
import type { RunnerSpawnOptions } from './types'
import { DEFAULT_AUTONOMY, type AutonomyLevel } from '../../shared/autonomy'
export type { CliRunnerDeps as ClaudeRunnerDeps } from './base'

const PERMISSION_MODE: Record<AutonomyLevel, string> = {
  read: 'plan',
  edit: 'acceptEdits',
  full: 'bypassPermissions'
}

/**
 * Anthropic Claude Code, invoked as
 * `claude -p --output-format stream-json --verbose --permission-mode <mode> [--model <model>]`
 * with the prompt piped through stdin. stream-json prints one event per
 * line as the agent works (plain `-p` prints nothing until the end);
 * ClaudeStreamFormatter turns the events into readable log lines. The
 * permission mode carries the mech's Autonomy level; `-p` already denies
 * anything that would need an interactive prompt, so MechBay never passes
 * `--permission-prompts` (older Claude versions reject it).
 */
export class ClaudeRunner extends CliRunner {
  protected command = 'claude'
  protected buildArgs(_prompt: string, options: RunnerSpawnOptions): string[] {
    const mode = PERMISSION_MODE[options.autonomy ?? DEFAULT_AUTONOMY]
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      '--permission-mode',
      mode,
      ...this.profileArgs,
      ...(options.model ? ['--model', options.model] : [])
    ]
  }

  protected stdinInput(prompt: string): string | null {
    return prompt
  }

  protected createStdoutTransform(): StreamTransform {
    return new ClaudeStreamFormatter()
  }
}
