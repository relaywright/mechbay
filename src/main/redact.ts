// Shorter values stay visible on purpose: variables named *KEY*/*TOKEN* often hold '1' or 'true'.
const MIN_SECRET_LENGTH = 8

/**
 * Replaces every occurrence of each secret in `text` with `[redacted]`.
 * A multi-line secret (a PEM key, say) is also hidden line by line, because
 * logs are split into lines before they are redacted. Longest secrets go
 * first, so a key that contains a shorter key is removed whole instead of
 * leaving its tail behind.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const pieces = secrets.flatMap((secret) => [
    secret,
    ...secret.split(/\r?\n/).map((line) => line.trim())
  ])
  const ordered = [...new Set(pieces)]
    .filter((secret) => secret.length >= MIN_SECRET_LENGTH)
    .sort((a, b) => b.length - a.length)
  let redacted = text
  for (const secret of ordered) redacted = redacted.split(secret).join('[redacted]')
  return redacted
}
