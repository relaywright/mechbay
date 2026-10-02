// Labels the hero Download button for the visitor's desktop OS. The link
// itself always points at the latest GitHub release, so it works without JS.

/**
 * @param {string} userAgent
 * @param {string} [platform]
 * @param {number} [maxTouchPoints]
 * @returns {'Windows' | 'macOS' | 'Linux' | null}
 */
export function detectDesktopOs(userAgent, platform = '', maxTouchPoints = 0) {
  if (/Android|iPhone|iPad|iPod|CrOS/i.test(userAgent)) return null
  if (/Win/i.test(platform) || /Windows NT/.test(userAgent)) return 'Windows'
  if (/Mac/i.test(platform) || /Macintosh|Mac OS X/.test(userAgent)) {
    // iPadOS reports a Mac user agent; a touch screen gives it away.
    return maxTouchPoints > 1 ? null : 'macOS'
  }
  if (/Linux/i.test(platform) || /X11|Linux/.test(userAgent)) return 'Linux'
  return null
}

const button = typeof document === 'undefined' ? null : document.getElementById('download')
if (button) {
  const platform = navigator.userAgentData?.platform ?? navigator.platform ?? ''
  const os = detectDesktopOs(navigator.userAgent, platform, navigator.maxTouchPoints ?? 0)
  if (os) button.textContent = `▸ DOWNLOAD FOR ${os.toUpperCase()}`
}
