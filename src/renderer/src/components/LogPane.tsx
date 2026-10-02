import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import type { LogChunk } from '../../../shared/types'
import { colors, type } from '../theme'

interface LogPaneProps {
  logs: LogChunk[]
  deployments?: { id: string; companionName: string; startedAt: number }[]
}

interface LogLine {
  id: string
  stream: LogChunk['stream']
  text: string
  timestamp: number
  deploymentId?: string
  isSeparator?: boolean
  deploymentLabel?: string
  thoughtKind?: 'intent' | 'findings'
}

const MAX_VISIBLE_LOGS = 500
const SCROLL_LOCK_THRESHOLD = 40

export function LogPane({ logs, deployments = [] }: LogPaneProps): React.JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null)
  const [isAutoScrollLocked, setIsAutoScrollLocked] = useState(false)
  const [userHasScrolled, setUserHasScrolled] = useState(false)
  const lastLogIdRef = useRef<string | null>(null)

  // Build processed lines with separators between deployments
  const lines = useMemo((): LogLine[] => {
    const result: LogLine[] = []
    let lastDeploymentId: string | null = null
    let lastTimestamp = 0

    for (const log of logs) {
      // Check if we need a separator
      const deploymentChanged = log.deploymentId !== lastDeploymentId
      const timeGap = log.timestamp - lastTimestamp > 2000 // 2+ second gap

      if ((deploymentChanged || timeGap) && lastDeploymentId !== null) {
        // Find deployment info for the separator
        const deployment = deployments.find((d) => d.id === log.deploymentId)
        if (deployment || deploymentChanged) {
          result.push({
            id: `sep-${log.id}`,
            stream: 'system',
            text: '',
            timestamp: log.timestamp,
            isSeparator: true,
            deploymentLabel: deployment
              ? `${deployment.companionName} · ${new Date(deployment.startedAt).toLocaleTimeString()}`
              : 'New deployment'
          })
        }
      }

      result.push({
        id: log.id,
        stream: log.stream,
        text: log.text,
        timestamp: log.timestamp,
        deploymentId: log.deploymentId,
        thoughtKind: log.thoughtKind
      })

      lastDeploymentId = log.deploymentId
      lastTimestamp = log.timestamp
    }

    // Trim to max visible
    if (result.length > MAX_VISIBLE_LOGS) {
      const trimmed = result.slice(-MAX_VISIBLE_LOGS)
      // Add header indicating truncation
      const hiddenCount = result.length - MAX_VISIBLE_LOGS
      trimmed.unshift({
        id: 'truncated-header',
        stream: 'system',
        text: `… ${hiddenCount} earlier entries`,
        timestamp: 0,
        isSeparator: true,
        deploymentLabel: undefined
      })
      return trimmed
    }

    return result
  }, [logs, deployments])

  // Auto-scroll to bottom when a new line arrives (unless locked). Keyed on
  // the newest line's id, not the count: once a long mission hits the view
  // cap the count stays flat while lines keep arriving.
  useEffect(() => {
    const lastId = logs.at(-1)?.id ?? null
    if (lastId === lastLogIdRef.current) return
    lastLogIdRef.current = lastId

    if (!isAutoScrollLocked && containerRef.current && lastId !== null) {
      const container = containerRef.current
      const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

      if (prefersReducedMotion) {
        container.scrollTop = container.scrollHeight
      } else {
        container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
      }
    }
  }, [logs, isAutoScrollLocked])

  // Handle scroll events to detect user scrolling up
  const handleScroll = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const distanceFromBottom = container.scrollHeight - container.scrollTop - container.clientHeight
    const wasLocked = isAutoScrollLocked
    const shouldLock = distanceFromBottom > SCROLL_LOCK_THRESHOLD

    if (shouldLock !== wasLocked) {
      setIsAutoScrollLocked(shouldLock)
    }

    if (!userHasScrolled) {
      setUserHasScrolled(true)
    }
  }, [isAutoScrollLocked, userHasScrolled])

  // Jump to latest button handler
  const handleJumpToLatest = useCallback(() => {
    const container = containerRef.current
    if (!container) return

    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    if (prefersReducedMotion) {
      container.scrollTop = container.scrollHeight
    } else {
      container.scrollTo({ top: container.scrollHeight, behavior: 'smooth' })
    }

    setIsAutoScrollLocked(false)
  }, [])

  // Empty state
  if (logs.length === 0) {
    return (
      <div style={emptyStateStyle}>
        <div style={emptyStateTextStyle}>
          <div className="eyebrow">MISSION CHANNEL / STANDING BY</div>
          <h2 className="dialog-heading" style={{ fontSize: 30, margin: '14px 0' }}>
            Every move, in view.
          </h2>
          <p style={{ fontFamily: type.sans, maxWidth: 250, lineHeight: 1.7 }}>
            Prepare a deployment in Operations. Your mech’s output will stream here as the mission
            unfolds.
          </p>
        </div>
      </div>
    )
  }

  return (
    <div style={containerStyle}>
      <div
        ref={containerRef}
        onScroll={handleScroll}
        style={scrollAreaStyle}
        role="log"
        aria-live="polite"
        aria-atomic="false"
      >
        {lines.map((line) => (
          <LogLineComponent key={line.id} line={line} />
        ))}
      </div>

      {isAutoScrollLocked && (
        <button
          type="button"
          onClick={handleJumpToLatest}
          style={jumpButtonStyle}
          aria-label="Jump to latest log entries"
        >
          ▼ JUMP TO LATEST
        </button>
      )}
    </div>
  )
}

function LogLineComponent({ line }: { line: LogLine }): React.JSX.Element {
  if (line.isSeparator) {
    return (
      <div style={separatorStyle}>
        <div style={separatorLineStyle} />
        {line.deploymentLabel && <span style={separatorLabelStyle}>{line.deploymentLabel}</span>}
        {line.text && <span style={separatorTextStyle}>{line.text}</span>}
        <div style={separatorLineStyle} />
      </div>
    )
  }

  if (line.stream === 'thought') {
    const isIntent = line.thoughtKind === 'intent'
    const cardStyle = isIntent ? intentCardStyle : findingsCardStyle
    const tagColor = isIntent ? colors.cyan : colors.amber
    const tagText = isIntent ? '▸ INTENT' : '◆ FINDINGS'
    return (
      <div style={cardStyle} role="status" aria-label={`${line.thoughtKind} narration`}>
        <div style={{ ...thoughtTagStyle, color: tagColor }}>{tagText}</div>
        <div style={thoughtBodyStyle}>{line.text}</div>
      </div>
    )
  }

  const streamColor = getStreamColor(line.stream)

  return (
    <div style={{ ...lineStyle, borderLeftColor: streamColor }}>
      <span style={{ ...streamBadgeStyle, color: streamColor }}>[{line.stream}]</span>
      <span style={lineTextStyle}>{line.text}</span>
    </div>
  )
}

function getStreamColor(stream: LogChunk['stream']): string {
  switch (stream) {
    case 'stdout':
      return colors.streamStdout
    case 'stderr':
      return colors.streamStderr
    case 'system':
      return colors.streamSystem
    case 'thought':
      // Defensive fallback — thought lines render via the card path above.
      return colors.cyan
    default:
      return colors.textSecondary
  }
}

// Styles
const containerStyle: React.CSSProperties = {
  position: 'relative',
  flex: 1,
  minHeight: 0,
  display: 'flex',
  flexDirection: 'column'
}

const scrollAreaStyle: React.CSSProperties = {
  background: colors.bgPanelDark,
  padding: 16,
  flex: 1,
  overflow: 'auto',
  fontFamily: type.mono,
  fontSize: 11,
  lineHeight: 1.5
}

const emptyStateStyle: React.CSSProperties = {
  background: colors.bgPanelDark,
  padding: 8,
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  fontFamily: type.mono,
  fontSize: 11
}

const emptyStateTextStyle: React.CSSProperties = {
  color: colors.textMuted,
  textAlign: 'center'
}

const lineStyle: React.CSSProperties = {
  display: 'flex',
  gap: 8,
  padding: '2px 0',
  borderLeftWidth: 2,
  borderLeftStyle: 'solid',
  paddingLeft: 8,
  marginBottom: 1
}

const streamBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.05em',
  flexShrink: 0,
  minWidth: 50
}

const lineTextStyle: React.CSSProperties = {
  color: colors.textPrimary,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}

const separatorStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 0',
  margin: '4px 0',
  color: colors.amber,
  fontSize: 10,
  letterSpacing: '0.1em'
}

const separatorLineStyle: React.CSSProperties = {
  flex: 1,
  height: 1,
  background: colors.borderHud,
  minWidth: 20
}

const separatorLabelStyle: React.CSSProperties = {
  color: colors.amber,
  fontWeight: 'bold',
  whiteSpace: 'nowrap'
}

const separatorTextStyle: React.CSSProperties = {
  color: colors.textSecondary,
  fontStyle: 'italic',
  whiteSpace: 'nowrap'
}

const jumpButtonStyle: React.CSSProperties = {
  position: 'absolute',
  bottom: 8,
  right: 8,
  background: colors.bgPanel,
  border: `1px solid ${colors.amber}`,
  color: colors.amber,
  padding: '6px 12px',
  fontSize: 10,
  fontWeight: 'bold',
  letterSpacing: '0.1em',
  cursor: 'pointer',
  fontFamily: type.mono,
  boxShadow: `0 2px 8px ${colors.amberGlow}`,
  zIndex: 10
}

const intentCardStyle: React.CSSProperties = {
  borderLeft: `3px solid ${colors.cyan}`,
  background: colors.cyanTint,
  padding: 8,
  margin: '6px 0'
}

const findingsCardStyle: React.CSSProperties = {
  borderLeft: `3px solid ${colors.amber}`,
  background: colors.amberTint,
  padding: 8,
  margin: '6px 0'
}

const thoughtTagStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: '0.1em',
  fontWeight: 'bold',
  marginBottom: 4
}

const thoughtBodyStyle: React.CSSProperties = {
  color: colors.textPrimary,
  fontSize: 12,
  lineHeight: 1.5,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word'
}
