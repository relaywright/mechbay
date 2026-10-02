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
