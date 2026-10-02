/**
 * True for a link the bay window may hand to the OS browser. Only https:
 * gets through; other schemes (file:, smb:, ms-settings: and the like) can
 * launch programs or open local files, so a compromised window must not be
 * able to reach them through window.open.
 */
export function isOpenableExternalUrl(url: string): boolean {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * True when `url` has the same scheme, host and port as `base`. A prefix
 * check is not enough: http://localhost:51730 starts with
 * http://localhost:5173.
 */
export function hasSameOrigin(url: string, base: string | undefined): boolean {
  if (!base) return false
  try {
    return new URL(url).origin === new URL(base).origin
  } catch {
    return false
  }
}
