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
})
