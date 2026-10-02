import { describe, expect, it } from 'vitest'
import { RUNTIME_SUPPORT, runtimeSupportNote } from '../../src/shared/runtime-support'

describe('runtime support labels', () => {
  it('marks only the runtimes the author checks every release as verified', () => {
    const verified = Object.entries(RUNTIME_SUPPORT)
      .filter(([, support]) => support.verifiedByAuthor)
      .map(([family]) => family)
    expect(verified).toEqual(['claude', 'codex'])
  })

  it('gives every unverified runtime a plain note that says so', () => {
    expect(runtimeSupportNote('kimi')).toBe('Bring your own key. Not verified by the author.')
    expect(runtimeSupportNote('gemini')).toBe('Bring your own key. Not verified by the author.')
    expect(runtimeSupportNote('hermes')).toBe(
      'Runs the agent command you configure. Not verified by the author.'
    )
    expect(runtimeSupportNote('claude')).toBeNull()
    expect(runtimeSupportNote('codex')).toBeNull()
  })
})
