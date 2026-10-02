import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { StoreLike } from '../../src/main/state-manager'

vi.mock('electron', () => ({ safeStorage: {} }))

import { SecretsManager } from '../../src/main/secrets'

function makeStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
}

const crypto = {
  isEncryptionAvailable: () => true,
  encryptString: (value: string) => Buffer.from('encrypted:' + value),
  decryptString: (value: Buffer) => {
    const decoded = value.toString()
    if (!decoded.startsWith('encrypted:')) throw new Error('corrupt blob')
    return decoded.slice('encrypted:'.length)
  }
}

describe('SecretsManager', () => {
  let store: StoreLike
  let secrets: SecretsManager

  beforeEach(() => {
    store = makeStore()
    secrets = new SecretsManager(store, crypto)
  })

  it('encrypts, stores, and decrypts a trimmed secret', () => {
    expect(secrets.setSecret('gemini', '  key-123  ')).toEqual({ ok: true })
    expect(store.get('secrets.gemini')).toBe(Buffer.from('encrypted:key-123').toString('base64'))
    expect(secrets.getSecret('gemini')).toBe('key-123')
  })

  it('clears a secret when given an empty value', () => {
    secrets.setSecret('codex', 'secret')
    expect(secrets.setSecret('codex', '   ')).toEqual({ ok: true })
    expect(secrets.getSecret('codex')).toBeNull()
  })

  it('reports status for every agent family without revealing values', () => {
    secrets.setSecret('kimi', 'secret')
    expect(secrets.getStatus()).toEqual({
      claude: false,
      codex: false,
      kimi: true,
      gemini: false,
      hermes: false
    })
  })

  it('rejects Claude secrets', () => {
    expect(secrets.setSecret('claude', 'nope')).toEqual({
      ok: false,
      error: 'Claude Code uses its own login, so no key is needed.'
    })
  })

  it('maps stored secrets to runtime-specific environment variables', () => {
    const mappings = [
      ['gemini', 'GEMINI_API_KEY'],
      ['kimi', 'FIREWORKS_API_KEY'],
      ['codex', 'OPENAI_API_KEY'],
      ['hermes', 'MECHBAY_HERMES_API_KEY']
    ] as const
    for (const [runtime, variable] of mappings) {
      secrets.setSecret(runtime, runtime + '-key')
      expect(secrets.envFor(runtime)).toEqual({ [variable]: runtime + '-key' })
    }
    expect(secrets.envFor('claude')).toEqual({})
    expect(new SecretsManager(makeStore(), crypto).envFor('gemini')).toEqual({})
  })

  it('returns an actionable error when OS encryption is unavailable', () => {
    const unavailable = new SecretsManager(store, {
      ...crypto,
      isEncryptionAvailable: () => false
    })
    expect(unavailable.setSecret('gemini', 'key')).toEqual({
      ok: false,
      error:
        'OS-level encryption is not available on this machine. Set the key as an environment variable instead.'
    })
  })

  it('returns null instead of throwing for a corrupted encrypted blob', () => {
    store.set('secrets.kimi', Buffer.from('not-valid').toString('base64'))
    expect(secrets.getSecret('kimi')).toBeNull()
  })
})
