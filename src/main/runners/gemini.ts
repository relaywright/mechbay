import { CliRunner } from './base'
import type { RunnerSpawnOptions } from './types'

/**
 * Google Gemini — invoked as `gemini -o text -y [-m <model>]` with the
 * prompt piped through stdin.
 * - `-o text` forces plain-text output (default is styled TTY)
 * - `-y` / --yolo auto-approves tool calls so the CLI doesn't block
 *   waiting for interactive confirmation inside Electron's sandbox.
 *   Gemini therefore offers only the Full Autonomy level (see
 *   src/shared/autonomy.ts); a stored lower level never changes this argv.
 */
export class GeminiRunner extends CliRunner {
  protected command = 'gemini'
  protected buildArgs(_prompt: string, options: RunnerSpawnOptions): string[] {
    return ['-o', 'text', '-y', ...(options.model ? ['-m', options.model] : [])]
  }

  protected stdinInput(prompt: string): string | null {
    return prompt
  }
}
