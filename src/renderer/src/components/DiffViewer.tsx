import { useEffect, useState } from 'react'
import type { DiffFileGetResult, FilePatch } from '../../../shared/types'
import './diff-viewer.css'
import { ipcErrorMessage } from '../../../shared/bridge-errors'

type ViewerState =
  { status: 'loading' } | { status: 'error'; error: string } | { status: 'ready'; patch: FilePatch }

/**
 * Fetches and renders the unified-diff patch for a single file via
 * IPC.DIFF_FILE_GET. Owns its own loading/error state so DebriefModal only
 * has to mount/unmount it per selected row.
 */
export function DiffViewer(props: { deploymentId: string; path: string }): React.JSX.Element {
  // Each settled result remembers which file it belongs to. When the
  // selected file changes, the stored result no longer matches, so the
  // viewer reads as loading without a synchronous reset inside the effect.
  const requestKey = `${props.deploymentId}\u0000${props.path}`
  const [settled, setSettled] = useState<{ key: string; state: ViewerState } | null>(null)
  const state: ViewerState =
    settled && settled.key === requestKey ? settled.state : { status: 'loading' }

  useEffect(() => {
    let cancelled = false
    const settle = (next: ViewerState): void => {
      if (!cancelled) setSettled({ key: requestKey, state: next })
    }

    window.mechbay
      .diffFileGet(props.deploymentId, props.path)
      .then((result: DiffFileGetResult) =>
        settle(
          result.ok
            ? { status: 'ready', patch: result.patch }
            : { status: 'error', error: result.error }
        )
      )
      .catch((err: unknown) => settle({ status: 'error', error: ipcErrorMessage(err) }))

    return () => {
      cancelled = true
    }
  }, [requestKey, props.deploymentId, props.path])

  if (state.status === 'loading') {
    return (
      <div className="diff-viewer diff-viewer-message" role="status">
        LOADING PATCH…
      </div>
    )
  }

  if (state.status === 'error') {
    return (
      <div className="diff-viewer diff-viewer-message diff-viewer-error" role="alert">
        {state.error}
      </div>
    )
  }

  const { patch } = state

  if (patch.binary) {
    return <div className="diff-viewer diff-viewer-message">Binary file, no line diff.</div>
  }

  if (patch.hunks.length === 0) {
    return (
      <div className="diff-viewer diff-viewer-message">
        No line-level changes for this file relative to the baseline.
      </div>
    )
  }

  return (
    <div className="diff-viewer">
      {patch.truncated && (
        <div className="diff-viewer-truncated">
          Patch truncated: showing the first part of a large diff.
        </div>
      )}
      <div className="diff-viewer-scroll">
        {patch.hunks.map((hunk, hunkIndex) => (
          <div className="diff-hunk" key={`${hunk.header}-${hunkIndex}`}>
            <div className="diff-hunk-header">{hunk.header}</div>
            {hunk.lines.map((line, lineIndex) => (
              <div className={`diff-line diff-line-${line.kind}`} key={lineIndex}>
                <span className="diff-line-no">{line.oldNo ?? ''}</span>
                <span className="diff-line-no">{line.newNo ?? ''}</span>
                <span className="diff-line-marker" aria-hidden="true">
                  {line.kind === 'add' ? '+' : line.kind === 'del' ? '-' : ' '}
                </span>
                <span className="diff-line-text">{line.text.length === 0 ? ' ' : line.text}</span>
              </div>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
