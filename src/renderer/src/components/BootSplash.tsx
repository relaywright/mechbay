import { useEffect, useState } from 'react'
import { colors, type } from '../theme'
import { bootLines, bootTimings } from './boot-splash'

const BOOT_LINES = bootLines(__APP_VERSION__)

const FADE_DURATION_MS = 400

interface BootSplashProps {
  reduceMotion: boolean
  onComplete: () => void
}

export function BootSplash({ reduceMotion, onComplete }: BootSplashProps): React.JSX.Element {
  const [visibleCharacters, setVisibleCharacters] = useState(reduceMotion ? Infinity : 0)
  const [fading, setFading] = useState(false)

  useEffect(() => {
    const timings = bootTimings(reduceMotion, BOOT_LINES)
    const totalCharacters = BOOT_LINES.reduce((total, line) => total + line.length, 0)
    let intervalId: ReturnType<typeof setInterval> | undefined
    let completionId: ReturnType<typeof setTimeout>

    if (reduceMotion) {
      completionId = setTimeout(onComplete, timings.holdDuration)
    } else {
      const startedAt = performance.now()
      intervalId = setInterval(() => {
        const elapsed = performance.now() - startedAt
        const nextCount = Math.min(
          totalCharacters,
          Math.floor((elapsed / timings.sequenceDuration) * totalCharacters)
        )
        setVisibleCharacters(nextCount)

        if (elapsed >= timings.sequenceDuration) {
          if (intervalId) clearInterval(intervalId)
          setVisibleCharacters(totalCharacters)
          setFading(true)
          completionId = setTimeout(onComplete, timings.fadeDuration)
        }
      }, 16)
    }

    const skip = (event: KeyboardEvent): void => {
      event.preventDefault()
      event.stopPropagation()
      onComplete()
    }
    window.addEventListener('keydown', skip, true)

    return () => {
      if (intervalId) clearInterval(intervalId)
      clearTimeout(completionId)
      window.removeEventListener('keydown', skip, true)
    }
  }, [onComplete, reduceMotion])

  return (
    <div
      style={{
        ...overlayStyle,
        opacity: fading ? 0 : 1,
        transition: fading ? `opacity ${FADE_DURATION_MS}ms ease-out` : 'none'
      }}
      onClick={onComplete}
      role="status"
      aria-label="MechBay system boot sequence"
    >
      {!reduceMotion && <div className="mechbay-boot-scanline" style={scanlineStyle} />}
      <div style={terminalStyle}>
        {BOOT_LINES.map((line, index) => {
          const charactersBefore = BOOT_LINES.slice(0, index).reduce(
            (total, previousLine) => total + previousLine.length,
            0
          )
          const visibleText = line.slice(0, Math.max(0, visibleCharacters - charactersBefore))
          return (
            <div key={line} style={lineStyle}>
              {renderLine(visibleText, line, index)}
            </div>
          )
        })}
      </div>
      <style>{`
        @keyframes mechbayBootScan {
          from { transform: translateY(-2px); opacity: 0; }
          8% { opacity: .75; }
          92% { opacity: .5; }
          to { transform: translateY(100vh); opacity: 0; }
        }
        .mechbay-boot-scanline { animation: mechbayBootScan 1.9s linear 120ms forwards; }
      `}</style>
    </div>
  )
}

function renderLine(visibleText: string, fullText: string, index: number): React.JSX.Element {
  if (index === 0 || index === BOOT_LINES.length - 1) {
    return <span style={{ color: colors.amber }}>{visibleText}</span>
  }

  const status = fullText.endsWith('OK') ? 'OK' : '5 MECHS'
  const detailLength = fullText.length - status.length
  const detail = visibleText.slice(0, detailLength)
  const visibleStatus = visibleText.slice(detailLength)

  return (
    <>
      <span style={{ color: colors.textDim }}>{detail}</span>
      <span style={{ color: status === 'OK' ? colors.streamStdout : colors.amber }}>
        {visibleStatus}
      </span>
    </>
  )
}

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  zIndex: 1000,
  overflow: 'hidden',
  display: 'grid',
  placeItems: 'center',
  background: colors.bgPanelDark,
  fontFamily: type.mono,
  cursor: 'default'
}

const terminalStyle: React.CSSProperties = {
  width: 'min(720px, calc(100vw - 64px))',
  fontSize: 'clamp(11px, 1.35vw, 16px)',
  lineHeight: 1.85,
  letterSpacing: type.hudTracking,
  whiteSpace: 'pre'
}

const lineStyle: React.CSSProperties = {
  minHeight: '1.85em',
  textShadow: `0 0 9px ${colors.amberGlow}`
}

const scanlineStyle: React.CSSProperties = {
  position: 'absolute',
  top: 0,
  left: 0,
  width: '100%',
  height: 1,
  background: colors.amber,
  boxShadow: `0 0 8px ${colors.amberGlow}`,
  pointerEvents: 'none'
}
