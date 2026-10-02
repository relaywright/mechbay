import { useState } from 'react'
import { ipcErrorMessage } from '../../../shared/bridge-errors'
import type { Deployment } from '../../../shared/types'

/** Cancel a queued mission or recall a running mech, with one confirmation step. */
export function RecallButton({ deployment }: { deployment: Deployment }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [pending, setPending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const queued = deployment.status === 'queued'

  async function confirm(): Promise<void> {
    setPending(true)
    setError(null)
    try {
      const result = await window.mechbay.deployAbort(deployment.id)
      if (result.ok) setConfirming(false)
      else setError(result.error)
    } catch (err) {
      console.error('[recall] deployAbort failed:', err)
      setError(ipcErrorMessage(err))
    } finally {
      setPending(false)
    }
  }

  return (
    <div className="recall-control">
      {confirming ? (
        <>
          <button
            type="button"
            className="recall-confirm"
            disabled={pending}
            onClick={() => void confirm()}
          >
            {queued ? 'Yes, cancel' : 'Yes, recall'}
          </button>
          <button
            type="button"
            className="text-action"
            disabled={pending}
            onClick={() => setConfirming(false)}
          >
            {queued ? 'Keep it in line' : 'Keep going'}
          </button>
        </>
      ) : (
        <button type="button" className="recall-start" onClick={() => setConfirming(true)}>
          {queued ? 'Cancel mission' : 'Recall mech'}
        </button>
      )}
      {error && (
        <p role="alert" className="recall-error">
          {error}
        </p>
      )}
    </div>
  )
}
