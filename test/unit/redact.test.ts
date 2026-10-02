import { describe, expect, it } from 'vitest'
import { redactSecrets } from '../../src/main/redact'

describe('redactSecrets', () => {
  it('returns the text unchanged when there are no secrets', () => {
    expect(redactSecrets('nothing to hide here', [])).toBe('nothing to hide here')
  })

  it('replaces every occurrence of every secret', () => {
    const text = 'key=fw-abcdef123 then sk-zyxwvu987 and fw-abcdef123 again'

    expect(redactSecrets(text, ['fw-abcdef123', 'sk-zyxwvu987'])).toBe(
      'key=[redacted] then [redacted] and [redacted] again'
    )
  })

  it('redacts the longest secret first when one contains another', () => {
    // If the short one went first, the long one's tail would be left behind.
    const text = 'token: abcdefgh12345678'

    expect(redactSecrets(text, ['abcdefgh', 'abcdefgh12345678'])).toBe('token: [redacted]')
  })

  it('ignores values shorter than 8 characters so ordinary words survive', () => {
    expect(redactSecrets('the test passed', ['test', 'the', ''])).toBe('the test passed')
  })

  it('hides each line of a multi-line secret, even when the text has only one line', () => {
    // Logs are split into lines before redaction, so a PEM arrives one line at a time.
    const pem = '-----BEGIN TEST KEY-----\r\nMIIBOgIBAAJBAKj34GkxFhD9\n-----END TEST KEY-----'

    expect(redactSecrets('line: MIIBOgIBAAJBAKj34GkxFhD9', [pem])).toBe('line: [redacted]')
    expect(redactSecrets('  -----END TEST KEY-----  ', [pem])).toBe('  [redacted]  ')
    expect(redactSecrets(`whole:\n${pem}`, [pem])).toBe('whole:\n[redacted]')
  })

  it('still leaves short lines of a multi-line secret visible', () => {
    expect(redactSecrets('a short ok line', ['ok\nlong-enough-line-here'])).toBe('a short ok line')
  })

  it('treats secrets as literal text, not patterns', () => {
    expect(redactSecrets('a.b*c+d?e(f) and axbxcxd', ['a.b*c+d?e(f)'])).toBe(
      '[redacted] and axbxcxd'
    )
  })

  it('hides the start of a key that a shortened line cut off', () => {
    const key = 'sk-ant-api03-ABCDEFGHIJKLMNOP'
    // Labels and long lines are shortened with a trailing ellipsis before
    // they are redacted, so a key can arrive cut short.
    expect(redactSecrets('Bash: curl -H "x-api-key: sk-ant-api03-ABCD\u2026', [key])).toBe(
      'Bash: curl -H "x-api-key: [redacted]\u2026'
    )
  })

  it('hides a cut-off key in the middle of the text too', () => {
    const key = 'fw-0123456789abcdef'
    expect(redactSecrets('TOOL ERROR \u00b7 fw-01234567\u2026 then more', [key])).toBe(
      'TOOL ERROR \u00b7 [redacted]\u2026 then more'
    )
  })

  it('leaves a cut-off fragment shorter than 8 characters visible', () => {
    expect(redactSecrets('token sk-ant-\u2026', ['sk-ant-api03-ABCDEFGHIJKLMNOP'])).toBe(
      'token sk-ant-\u2026'
    )
  })

  it('does not hide ordinary text before an ellipsis', () => {
    expect(redactSecrets('reading the configuration\u2026', ['sk-ant-api03-ABCDEFGH'])).toBe(
      'reading the configuration\u2026'
    )
  })
})
