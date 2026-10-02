import { safeStorage } from 'electron'
import type { AgentFamily } from '../shared/types'
import type { StoreLike } from './state-manager'

interface SecretCrypto {
  isEncryptionAvailable(): boolean
  encryptString(value: string): Buffer
  decryptString(value: Buffer): string
}

const ENV_BY_RUNTIME: Partial<Record<AgentFamily, string>> = {
  gemini: 'GEMINI_API_KEY',
  kimi: 'FIREWORKS_API_KEY',
  codex: 'OPENAI_API_KEY',
  hermes: 'MECHBAY_HERMES_API_KEY'
}

const AGENT_FAMILIES: AgentFamily[] = ['claude', 'codex', 'kimi', 'gemini', 'hermes']

export class SecretsManager {
  constructor(
    private readonly store: StoreLike,
    private readonly crypto: SecretCrypto = safeStorage
  ) {}

  setSecret(runtime: AgentFamily, value: string): { ok: boolean; error?: string } {
    if (runtime === 'claude') {
      return { ok: false, error: 'Claude Code uses its own login, so no key is needed.' }
    }
    const trimmed = value.trim()
    if (!trimmed) {
      this.clearSecret(runtime)
      return { ok: true }
    }
    if (!this.crypto.isEncryptionAvailable()) {
      return {
        ok: false,
        error:
          'OS-level encryption is not available on this machine. Set the key as an environment variable instead.'
      }
    }
    const encrypted = this.crypto.encryptString(trimmed)
    this.store.set(this.key(runtime), encrypted.toString('base64'))
    return { ok: true }
  }

  clearSecret(runtime: AgentFamily): void {
    this.store.set(this.key(runtime), '')
  }

  getSecret(runtime: AgentFamily): string | null {
    if (runtime === 'claude') return null
    const raw = this.store.get(this.key(runtime))
    if (typeof raw !== 'string' || raw.length === 0) return null
    try {
      return this.crypto.decryptString(Buffer.from(raw, 'base64'))
    } catch (err) {
      console.error(`[secrets] Failed to decrypt ${runtime} secret:`, err)
      return null
    }
  }

  getStatus(): Record<AgentFamily, boolean> {
    return Object.fromEntries(
      AGENT_FAMILIES.map((runtime) => [runtime, this.getSecret(runtime) !== null])
    ) as Record<AgentFamily, boolean>
  }

  envFor(runtime: AgentFamily): Record<string, string> {
    const variable = ENV_BY_RUNTIME[runtime]
    if (!variable) return {}
    const value = this.getSecret(runtime)
    return value ? { [variable]: value } : {}
  }

  private key(runtime: AgentFamily): string {
    return `secrets.${runtime}`
  }
}
