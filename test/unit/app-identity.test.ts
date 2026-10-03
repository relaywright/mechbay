import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const BUILDER = readFileSync('electron-builder.yml', 'utf8').replace(/\r\n/g, '\n')
const MAIN = readFileSync('src/main/index.ts', 'utf8')

// electron-builder derives the Windows installer GUID from appId unless
// nsis.guid is set. Installs up to v1.4.3 used com.sam.mechbay, which
// derives this GUID. Losing it makes the next installer register a second
// MechBay in Installed apps instead of upgrading the first.
const SHIPPED_INSTALLER_GUID = '5046ab0a-889b-59aa-921f-20e31c899a46'

describe('app identity', () => {
  const appId = BUILDER.match(/^appId: (\S+)$/m)?.[1]

  it('uses the relaywright app id in the installer and the Windows taskbar id', () => {
    expect(appId).toBe('io.github.relaywright.mechbay')
    expect(MAIN).toContain(`setAppUserModelId('${appId}')`)
  })

  it('keeps the installer GUID that earlier releases shipped with', () => {
    const nsis = BUILDER.slice(BUILDER.indexOf('\nnsis:\n'), BUILDER.indexOf('\nmac:\n'))
    expect(nsis).toContain(`\n  guid: ${SHIPPED_INSTALLER_GUID}\n`)
  })

  it('names no person in the build metadata', () => {
    expect(BUILDER).not.toMatch(/com\.sam\b|albanese/i)
  })
})
