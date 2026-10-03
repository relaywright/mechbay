/**
 * Errors a bridge method throws when a shell cannot do something
 * (spec 7.5). Electron rebuilds errors in the renderer from their message
 * alone, so the code travels inside the message as a `[code]` prefix.
 */
export type BridgeErrorCode = 'desktop-only' | 'not-yet-available'

export class BridgeError extends Error {
  constructor(
    readonly code: BridgeErrorCode,
    readonly detail: string
  ) {
    super(`[${code}] ${detail}`)
    this.name = 'BridgeError'
  }
}

/** The web demo cannot do this; the desktop app can. */
export class DesktopOnlyError extends BridgeError {
  constructor(detail: string) {
    super('desktop-only', detail)
    this.name = 'DesktopOnlyError'
  }
}

/** The contract exists, the feature ships in a later release. */
export class NotYetAvailableError extends BridgeError {
  constructor(detail: string) {
    super('not-yet-available', detail)
    this.name = 'NotYetAvailableError'
  }
}

// Anchored: the code is a prefix of the message, so a `[desktop-only]` that is
// part of an ordinary message (a folder name) is not read as one.
const CODED = /^\[(desktop-only|not-yet-available)\] ([\s\S]*)$/
const ELECTRON_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

/** The error's message without the wrapper Electron adds in the renderer. */
function unwrapped(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(ELECTRON_PREFIX, '')
}

export function parseBridgeError(err: unknown): { code: BridgeErrorCode; detail: string } | null {
  const match = CODED.exec(unwrapped(err))
  return match ? { code: match[1] as BridgeErrorCode, detail: match[2] } : null
}

/** A message fit to show a person: no Electron wrapper, no `[code]` prefix. */
export function ipcErrorMessage(err: unknown): string {
  return parseBridgeError(err)?.detail ?? unwrapped(err)
}
