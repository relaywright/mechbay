import { CliRunner } from './base'
import { ClaudeStreamFormatter, type StreamTransform } from './claude-stream'
export type { CliRunnerDeps as ClaudeRunnerDeps } from './base'

/**
 * Anthropic Claude Code, invoked as
 * `claude -p --output-format stream-json --verbose [--model <model>]` with
 * the prompt piped through stdin. stream-json prints one event per line as
 * the agent works (plain `-p` prints nothing until the end);
 * ClaudeStreamFormatter turns the events into readable log lines.
 */
export class ClaudeRunner extends CliRunner {
  protected command = 'claude'
  protected buildArgs(_prompt: string, model?: string): string[] {
    return [
      '-p',
      '--output-format',
      'stream-json',
      '--verbose',
      ...(model ? ['--model', model] : [])
    ]
  }

  protected stdinInput(prompt: string): string | null {
    return prompt
  }

  protected createStdoutTransform(): StreamTransform {
    return new ClaudeStreamFormatter()
  }
}
