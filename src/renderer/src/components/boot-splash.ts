/**
 * Cockpit start-up checklist, MechWarrior style. Each subsystem is a real
 * part of the app coming up (reactor = the runner boundary that powers the
 * mechs, sensors = the bay projector, comms = the HUD). The version comes
 * from package.json at build time (__APP_VERSION__, see
 * electron.vite.config.ts), never by hand.
 */
export function bootLines(version: string): readonly string[] {
  return [
    `MECHBAY OS v${version} · COMBINE STANDARD BOOT`,
    '▸ REACTOR · RUNNER BOUNDARY ..... ONLINE',
    '▸ SENSORS · ISO GRID PROJECTOR .. ONLINE',
    '▸ COMMS · HUD SUBSYSTEMS ........ ONLINE',
    '▸ MEMORY · SOUL ARCHIVE ......... ONLINE',
    '▸ LANCE ROSTER .................. 5 MECHS',
    '◈ ALL SYSTEMS NOMINAL · CMDR ON DECK'
  ]
}

const TYPE_DURATION_MS = 2200
const REDUCED_HOLD_MS = 600
const FADE_DURATION_MS = 400

export interface BootLineTiming {
  text: string
  startAt: number
  endAt: number
}

export interface BootTimings {
  sequenceDuration: number
  holdDuration: number
  fadeDuration: number
  lines: BootLineTiming[]
}

export function bootTimings(reduceMotion: boolean, lines: readonly string[]): BootTimings {
  if (reduceMotion) {
    return {
      sequenceDuration: 0,
      holdDuration: REDUCED_HOLD_MS,
      fadeDuration: 0,
      lines: lines.map((text) => ({ text, startAt: 0, endAt: 0 }))
    }
  }

  const characterCount = lines.reduce((total, line) => total + line.length, 0)
  let elapsedCharacters = 0
  const timedLines = lines.map((text) => {
    const startAt = Math.round((elapsedCharacters / characterCount) * TYPE_DURATION_MS)
    elapsedCharacters += text.length
    return {
      text,
      startAt,
      endAt: Math.round((elapsedCharacters / characterCount) * TYPE_DURATION_MS)
    }
  })

  return {
    sequenceDuration: TYPE_DURATION_MS,
    holdDuration: 0,
    fadeDuration: FADE_DURATION_MS,
    lines: timedLines
  }
}
