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

const CODED = /\[(desktop-only|not-yet-available)\] ([\s\S]*)$/
const ELECTRON_PREFIX = /^Error invoking remote method '[^']+': (?:[A-Za-z]*Error: )?/

export function parseBridgeError(err: unknown): { code: BridgeErrorCode; detail: string } | null {
  const message = err instanceof Error ? err.message : String(err)
  const match = CODED.exec(message)
  return match ? { code: match[1] as BridgeErrorCode, detail: match[2] } : null
}

/** A message fit to show a person: no Electron wrapper, no `[code]` prefix. */
export function ipcErrorMessage(err: unknown): string {
  const coded = parseBridgeError(err)
  if (coded) return coded.detail
  const message = err instanceof Error ? err.message : String(err)
  return message.replace(ELECTRON_PREFIX, '')
}
