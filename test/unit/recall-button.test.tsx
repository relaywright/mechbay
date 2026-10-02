// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RecallButton } from '../../src/renderer/src/components/RecallButton'
import type { Deployment } from '../../src/shared/types'

const mission = (status: Deployment['status']): Deployment => ({
  id: 'm1',
  companionId: 'c',
  facilityId: 'f',
  taskPrompt: 't',
  status,
  startedAt: 1
})

afterEach(cleanup)

describe('RecallButton', () => {
  it('asks once before cancelling a queued mission', async () => {
    const deployAbort = vi.fn(async () => ({ ok: true as const }))
    Object.assign(window, { mechbay: { deployAbort } })
    render(<RecallButton deployment={mission('queued')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel mission' }))
    expect(deployAbort).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }))
    await waitFor(() => expect(deployAbort).toHaveBeenCalledWith('m1'))
  })

  it('backs out with Keep going', () => {
    Object.assign(window, { mechbay: { deployAbort: vi.fn() } })
    render(<RecallButton deployment={mission('working')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recall mech' }))
    fireEvent.click(screen.getByRole('button', { name: 'Keep going' }))
    expect(screen.getByRole('button', { name: 'Recall mech' })).toBeTruthy()
  })

  it('shows why a recall failed', async () => {
    Object.assign(window, {
      mechbay: {
        deployAbort: vi.fn(async () => ({
          ok: false as const,
          error: 'This mission has already ended.'
        }))
      }
    })
    render(<RecallButton deployment={mission('queued')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Cancel mission' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, cancel' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'This mission has already ended.'
    )
  })

  it('shows a bridge error without its technical prefix', async () => {
    Object.assign(window, {
      mechbay: {
        deployAbort: vi.fn(async () => {
          throw new Error(
            "Error invoking remote method 'mechbay:deploy:abort': Error: [not-yet-available] Recalling a running mission arrives in this release."
          )
        })
      }
    })
    render(<RecallButton deployment={mission('working')} />)
    fireEvent.click(screen.getByRole('button', { name: 'Recall mech' }))
    fireEvent.click(screen.getByRole('button', { name: 'Yes, recall' }))
    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      'Recalling a running mission arrives in this release.'
    )
  })
})
