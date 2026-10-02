// Shorter values stay visible on purpose: variables named *KEY*/*TOKEN* often hold '1' or 'true'.
const MIN_SECRET_LENGTH = 8

/** What the stream formatter appends when it shortens a label or line (claude-stream.ts `clip`). */
const ELLIPSIS = '…'

/**
 * Replaces every occurrence of each secret in `text` with `[redacted]`.
 * A multi-line secret (a PEM key, say) is also hidden line by line, because
 * logs are split into lines before they are redacted. Longest secrets go
 * first, so a key that contains a shorter key is removed whole instead of
 * leaving its tail behind.
 *
 * Labels and long lines are shortened before they reach here, so a key can
 * also arrive cut off just before an ellipsis; its start is hidden too.
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
  return hideCutOffSecrets(redacted, ordered)
}

/** Hide the longest start of any secret (8+ characters) that ends right at an ellipsis. */
function hideCutOffSecrets(text: string, secrets: readonly string[]): string {
  let out = ''
  let from = 0
  for (let at = text.indexOf(ELLIPSIS); at !== -1; at = text.indexOf(ELLIPSIS, at + 1)) {
    let cut = 0
    for (const secret of secrets) {
      for (let k = Math.min(secret.length - 1, at - from); k >= MIN_SECRET_LENGTH && k > cut; k--) {
        if (text.startsWith(secret.slice(0, k), at - k)) {
          cut = k
          break
        }
      }
    }
    if (cut > 0) {
      out += `${text.slice(from, at - cut)}[redacted]`
      from = at
    }
  }
  return out + text.slice(from)
}
