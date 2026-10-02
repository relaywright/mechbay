import { CliRunner } from './base'
import type { RunnerSpawnOptions } from './types'

/**
 * Split a user-provided command line without invoking a shell. Quotes group
 * tokens but are not included in the argv passed to the child process.
 */
export function tokenizeHermesCommand(commandLine: string): string[] {
  const tokens: string[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  let tokenStarted = false

  for (const char of commandLine) {
    if (quote !== null) {
      if (char === quote) {
        quote = null
      } else {
        token += char
      }
      tokenStarted = true
      continue
    }

    if (char === '"' || char === "'") {
      quote = char
      tokenStarted = true
    } else if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(token)
        token = ''
        tokenStarted = false
      }
    } else {
      token += char
      tokenStarted = true
    }
  }

  if (tokenStarted) tokens.push(token)
  return tokens
}

/**
 * Locust-Prime's bring-your-own-agent runner. Configure a full command line
 * through MECHBAY_HERMES_CMD, such as `aider --yes --message {PROMPT}`.
 */
export class HermesRunner extends CliRunner {
  protected get command(): string {
    return this.commandTokens()[0] ?? ''
  }

  private commandTokens(): string[] {
    return tokenizeHermesCommand(process.env.MECHBAY_HERMES_CMD ?? '')
  }

  async isAvailable(): Promise<boolean> {
    const command = this.commandTokens()[0]
    return command !== undefined && (await this.which(command)) !== null
  }

  protected buildArgs(prompt: string, options: RunnerSpawnOptions): string[] {
    const model = options.model
    return this.commandTokens()
      .slice(1)
      .map((token) => token.replaceAll('{PROMPT}', prompt))
      .map((token) => {
        const hadModelPlaceholder = token.includes('{MODEL}')
        const substituted = token.replaceAll('{MODEL}', model ?? '')
        // Only drop tokens that existed solely to carry {MODEL} and ended
        // up empty because no model override was set — never drop a
        // token that was legitimately empty for unrelated reasons.
        return hadModelPlaceholder && substituted.length === 0 ? null : substituted
      })
      .filter((token): token is string => token !== null)
  }

  protected stdinInput(prompt: string): string | null {
    return this.commandTokens().some((token) => token.includes('{PROMPT}')) ? null : prompt
  }
}
