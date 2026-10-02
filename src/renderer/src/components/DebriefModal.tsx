import { useCallback, useEffect, useRef, useState } from 'react'
import type { Companion, Deployment, Facility } from '../../../shared/types'
import { sfx } from '../audio/sfx'
import { useCountUp } from '../motion'
import { colors, type } from '../theme'
import { DiffViewer } from './DiffViewer'

const TASK_LIMIT = 200
const FILE_LIMIT = 20
/** When the stamp lands (matches .debrief-stamp's animation delay in command.css). */
const STAMP_AT_MS = 260
/** Stat count-up starts once the hologram panel has finished projecting. */
const COUNT_DELAY_MS = 160

function truncateTask(task: string): string {
  return task.length > TASK_LIMIT ? `${task.slice(0, TASK_LIMIT)}…` : task
}

function formatDuration(deployment: Deployment): string {
  const end = deployment.completedAt ?? Date.now()
  const totalSeconds = Math.max(0, Math.floor((end - deployment.startedAt) / 1000))
  const minutes = Math.floor(totalSeconds / 60)
  const seconds = totalSeconds % 60

  return minutes > 0 ? `${minutes}m ${seconds.toString().padStart(2, '0')}s` : `${seconds}s`
}

const STAMP_TEXT: Partial<Record<Deployment['status'], string>> = {
  completed: 'MISSION COMPLETE',
  failed: 'MISSION FAILED',
  cancelled: 'MISSION SCRUBBED'
}

/** After-action numbers roll up from zero once, as the report projects in. */
function DebriefSummary({
  stats
}: {
  stats: NonNullable<Deployment['diffStats']>
}): React.JSX.Element {
  const files = useCountUp(stats.filesChanged, 420, COUNT_DELAY_MS)
  const insertions = useCountUp(stats.insertions, 520, COUNT_DELAY_MS)
  const deletions = useCountUp(stats.deletions, 520, COUNT_DELAY_MS)
  return (
    <div className="debrief-summary" aria-label="Change summary">
      <div>
        <strong>{files.toString().padStart(2, '0')}</strong>
        <span>FILES CHANGED</span>
      </div>
      <div>
        <strong>+{insertions}</strong>
        <span>LINES ADDED</span>
      </div>
      <div>
        <strong>−{deletions}</strong>
        <span>LINES REMOVED</span>
      </div>
    </div>
  )
}

export function DebriefModal(props: {
  deployment: Deployment
  companion: Companion
  facility: Facility
  onDismiss: () => void
}): React.JSX.Element {
  const dismissButtonRef = useRef<HTMLButtonElement>(null)
  const { deployment } = props
  const diffFiles = deployment.diffFiles
  const visibleFiles = diffFiles?.slice(0, FILE_LIMIT) ?? []
  const hiddenFiles = Math.max(
    0,
    (deployment.diffStats?.filesChanged ?? diffFiles?.length ?? 0) - visibleFiles.length
  )
  const [selectedPath, setSelectedPath] = useState<string | null>(
    visibleFiles.length > 0 ? visibleFiles[0].path : null
  )

  const { onDismiss } = props
  const handleDismiss = useCallback(() => {
    sfx.play('ui-close')
    onDismiss()
  }, [onDismiss])
  useEffect(() => {
    dismissButtonRef.current?.focus()
    const onKey = (event: KeyboardEvent): void => {
      // Escape-only: file rows are focusable and Enter selects one, so
      // dismissing the whole modal on Enter would fight that interaction.
      if (event.key === 'Escape') handleDismiss()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleDismiss])

  // Projector hum on open, then the outcome sting as the stamp lands.
  // Timers (not immediate calls) so StrictMode's double mount plays once.
  const outcome = deployment.status
  useEffect(() => {
    const open = setTimeout(() => sfx.play('ui-open'), 0)
    const sting = setTimeout(() => {
      if (outcome === 'completed') sfx.play('complete')
      else if (outcome === 'failed') sfx.play('fail')
    }, STAMP_AT_MS)
    return () => {
      clearTimeout(open)
      clearTimeout(sting)
    }
  }, [outcome])
  const stamp = STAMP_TEXT[outcome]

  return (
    <div style={backdropStyle} className="holo-backdrop">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="mission-debrief-title"
        style={panelStyle}
        className="holo-panel"
      >
        <div className="debrief-banner">
          <div>
            <div className="eyebrow">MISSION DEBRIEF / AFTER-ACTION REPORT</div>
            <h2 className="dialog-heading">Objective complete.</h2>
          </div>
          <div className="debrief-banner-marks">
            {stamp && <span className={`debrief-stamp stamp-${outcome}`}>{stamp}</span>}
            <span className="debrief-check" aria-hidden="true">
              ✓
            </span>
          </div>
        </div>
        <div id="mission-debrief-title" style={titleStyle}>
          ■ MISSION DEBRIEF / {props.companion.name.toUpperCase()} ←{' '}
          {props.facility.name.toUpperCase()}
        </div>
        <div style={subtitleStyle}>AFTER-ACTION TELEMETRY</div>

        {deployment.diffStats && <DebriefSummary stats={deployment.diffStats} />}

        <dl style={detailListStyle}>
          <div style={detailRowStyle}>
            <dt style={labelStyle}>TASK</dt>
            <dd style={taskValueStyle}>{truncateTask(deployment.taskPrompt)}</dd>
          </div>
          <div style={detailRowStyle}>
            <dt style={labelStyle}>DURATION</dt>
            <dd style={valueStyle}>{formatDuration(deployment)}</dd>
          </div>
          <div style={detailRowStyle}>
            <dt style={labelStyle}>EXIT CODE</dt>
            <dd style={valueStyle}>{deployment.exitCode ?? 'N/A'}</dd>
          </div>
          <div style={detailRowStyle}>
            <dt style={labelStyle}>SUMMARY</dt>
            <dd style={summaryValueStyle}>{deployment.summary ?? 'Completed.'}</dd>
          </div>
        </dl>

        {diffFiles === undefined ? (
          // The summary names the reason (no repository, or git could not read it).
          <div style={unavailableStyle}>File diff unavailable. The summary above says why.</div>
        ) : (
          <section aria-label="File changes">
            <div style={tableLabelStyle}>FILE DELTA</div>
            {visibleFiles.length === 0 ? (
              <div style={emptyFilesStyle}>NO TRACKED OR UNTRACKED FILE CHANGES</div>
            ) : (
              <div style={tableWrapStyle}>
                <table style={tableStyle}>
                  <thead>
                    <tr>
                      <th style={pathHeaderStyle}>PATH</th>
                      <th style={numberHeaderStyle}>+INS</th>
                      <th style={numberHeaderStyle}>−DEL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleFiles.map((file) => {
                      const isSelected = file.path === selectedPath
                      const rowId = `debrief-diff-row-${file.path}`
                      return (
                        <tr key={file.path}>
                          <td colSpan={3} style={{ padding: 0 }}>
                            <button
                              type="button"
                              id={rowId}
                              className="debrief-file-row"
                              aria-expanded={isSelected}
                              aria-controls={isSelected ? 'debrief-diff-panel' : undefined}
                              style={fileRowStyle}
                              onClick={() =>
                                setSelectedPath((current) =>
                                  current === file.path ? null : file.path
                                )
                              }
                            >
                              <span style={pathCellInnerStyle} title={file.path}>
                                {file.path}
                              </span>
                              <span style={insertionCellInnerStyle}>+{file.insertions}</span>
                              <span style={deletionCellInnerStyle}>−{file.deletions}</span>
                            </button>
                          </td>
                        </tr>
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
            {hiddenFiles > 0 && <div style={moreFilesStyle}>… +{hiddenFiles} more files</div>}
            {selectedPath && (
              <div id="debrief-diff-panel" role="region" aria-label={`Diff for ${selectedPath}`}>
                <DiffViewer deploymentId={deployment.id} path={selectedPath} />
              </div>
            )}
          </section>
        )}

        <p className="debrief-note">
          Read from the project’s current working tree against the pre-mission baseline: if you
          edited files after the mission finished, those edits are included too. Line totals cover
          tracked and new text files; binary files are counted without line totals.
        </p>
        <div style={actionRowStyle}>
          <button
            ref={dismissButtonRef}
            type="button"
            onClick={handleDismiss}
            style={dismissButtonStyle}
            className="cta-sheen"
          >
            ACKNOWLEDGED
          </button>
        </div>
      </div>
    </div>
  )
}

const backdropStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: colors.overlay,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 110
}

const panelStyle: React.CSSProperties = {
  width: 'min(1080px, calc(100vw - 48px))',
  maxHeight: 'calc(100vh - 48px)',
  overflow: 'auto',
  background: colors.bgHud,
  border: `1px solid ${colors.amber}`,
  boxShadow: '0 24px 100px #0008',
  padding: 30,
  color: colors.textPrimary,
  fontFamily: type.mono
}

const titleStyle: React.CSSProperties = {
  color: colors.orange,
  fontSize: 14,
  fontWeight: 'bold',
  letterSpacing: type.labelTracking,
  lineHeight: 1.45
}

const subtitleStyle: React.CSSProperties = {
  color: colors.cyan,
  fontSize: 10,
  fontWeight: 'bold',
  letterSpacing: type.hudTracking,
  marginTop: 6,
  marginBottom: 16
}

const detailListStyle: React.CSSProperties = {
  margin: 0,
  borderTop: `1px solid ${colors.borderHud}`
}

const detailRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '96px minmax(0, 1fr)',
  gap: 12,
  padding: '8px 0',
  borderBottom: `1px solid ${colors.borderHud}`
}

const labelStyle: React.CSSProperties = {
  color: colors.amber,
  fontSize: 10,
  fontWeight: 'bold',
  letterSpacing: type.hudTracking
}

const valueStyle: React.CSSProperties = {
  margin: 0,
  color: colors.textPrimary,
  fontSize: 12
}

const taskValueStyle: React.CSSProperties = {
  ...valueStyle,
  lineHeight: 1.45,
  overflowWrap: 'anywhere'
}

const summaryValueStyle: React.CSSProperties = {
  ...valueStyle,
  color: colors.cyan,
  lineHeight: 1.45
}

const unavailableStyle: React.CSSProperties = {
  marginTop: 16,
  padding: 10,
  background: colors.bgPanelDark,
  border: `1px solid ${colors.borderHud}`,
  color: colors.textSecondary,
  fontSize: 11
}

const tableLabelStyle: React.CSSProperties = {
  marginTop: 16,
  marginBottom: 6,
  color: colors.amber,
  fontSize: 10,
  fontWeight: 'bold',
  letterSpacing: type.hudTracking
}

const tableWrapStyle: React.CSSProperties = {
  maxHeight: 260,
  overflow: 'auto',
  background: colors.bgPanelDark,
  border: `1px solid ${colors.borderHud}`
}

const tableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 11
}

const pathHeaderStyle: React.CSSProperties = {
  padding: '7px 10px',
  borderBottom: `1px solid ${colors.borderHud}`,
  color: colors.textSecondary,
  fontSize: 10,
  letterSpacing: type.hudTracking,
  textAlign: 'left'
}

const numberHeaderStyle: React.CSSProperties = {
  ...pathHeaderStyle,
  textAlign: 'right',
  width: 64
}

const fileRowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'minmax(0, 1fr) 64px 64px',
  width: '100%',
  padding: '6px 10px',
  borderBottom: `1px dotted ${colors.borderHud}`,
  fontSize: 11,
  fontFamily: 'inherit'
}

const pathCellInnerStyle: React.CSSProperties = {
  overflow: 'hidden',
  color: colors.textPrimary,
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  textAlign: 'left'
}

const insertionCellInnerStyle: React.CSSProperties = {
  color: colors.statusWorking,
  textAlign: 'right',
  whiteSpace: 'nowrap'
}

const deletionCellInnerStyle: React.CSSProperties = {
  ...insertionCellInnerStyle,
  color: colors.statusFailed
}

const emptyFilesStyle: React.CSSProperties = {
  padding: 10,
  background: colors.bgPanelDark,
  border: `1px solid ${colors.borderHud}`,
  color: colors.textSecondary,
  fontSize: 11
}

const moreFilesStyle: React.CSSProperties = {
  marginTop: 6,
  color: colors.textSecondary,
  fontSize: 11
}

const actionRowStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  marginTop: 20
}

const dismissButtonStyle: React.CSSProperties = {
  background: colors.orange,
  color: colors.bg,
  border: 0,
  padding: '8px 20px',
  fontFamily: 'inherit',
  fontSize: 12,
  fontWeight: 'bold',
  letterSpacing: type.hudTracking,
  cursor: 'pointer'
}
