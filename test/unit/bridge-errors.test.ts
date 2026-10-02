import { describe, expect, it } from 'vitest'
import {
  BridgeError,
  DesktopOnlyError,
  NotYetAvailableError,
  ipcErrorMessage,
  parseBridgeError
} from '../../src/shared/bridge-errors'

describe('bridge errors', () => {
  it('encodes the code in the message so it survives the IPC boundary', () => {
    const err = new NotYetAvailableError('Reviewing changes arrives in v1.5.')
    expect(err).toBeInstanceOf(BridgeError)
    expect(err.code).toBe('not-yet-available')
    expect(err.message).toBe('[not-yet-available] Reviewing changes arrives in v1.5.')
  })

  it('parses an error that Electron re-wrapped in the renderer', () => {
    const wrapped = new Error(
      "Error invoking remote method 'mechbay:review:approve': Error: [desktop-only] Open the desktop app to approve changes."
    )
    expect(parseBridgeError(wrapped)).toEqual({
      code: 'desktop-only',
      detail: 'Open the desktop app to approve changes.'
    })
    expect(new DesktopOnlyError('x').code).toBe('desktop-only')
  })

  it('returns null for an ordinary error', () => {
    expect(parseBridgeError(new Error('disk full'))).toBeNull()
  })

  it('reads a code only at the start of the message, never inside a folder name', () => {
    const message = 'Access denied: C:\\Projects\\[desktop-only] Reports'
    expect(parseBridgeError(new Error(message))).toBeNull()
    expect(
      ipcErrorMessage(new Error(`Error invoking remote method 'fs:read-dir': Error: ${message}`))
    ).toBe(message)
    expect(ipcErrorMessage(new DesktopOnlyError('Open the desktop app.'))).toBe(
      'Open the desktop app.'
    )
  })

  it('strips the Electron prefix for display', () => {
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'mechbay:deploy:start': Error: Foundry isn't linked to a project folder yet."
        )
      )
    ).toBe("Foundry isn't linked to a project folder yet.")
    expect(
      ipcErrorMessage(
        new Error(
          "Error invoking remote method 'mechbay:deploy:abort': Error: [not-yet-available] Recall arrives soon."
        )
      )
    ).toBe('Recall arrives soon.')
    expect(ipcErrorMessage('plain string')).toBe('plain string')
  })
})
