// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { StateRecoveryModal } from '../../src/renderer/src/components/StateRecoveryModal'

afterEach(cleanup)

describe('StateRecoveryModal', () => {
  it('explains a refused newer save and continues without saving', () => {
    const onDismiss = vi.fn()
    render(
      <StateRecoveryModal
        health={{
          ok: false,
          reason: 'newer-version',
          message: 'This saved bay was written by a newer version of MechBay.',
          statePath: 'C:\\Users\\pilot\\AppData\\Roaming\\mechbay\\mechbay-state.json'
        }}
        onDismiss={onDismiss}
      />
    )
    expect(screen.getByRole('alertdialog', { name: 'Saved by a newer MechBay' })).toBeTruthy()
    expect(screen.getByText(/mechbay-state\.json/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Continue without saving' }))
    expect(onDismiss).toHaveBeenCalledOnce()
  })

  it('shows a one-time notice with a plain OK', () => {
    render(
      <StateRecoveryModal
        health={{ ok: true, notice: 'MechBay started a fresh one.', freshBay: true }}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByRole('alertdialog', { name: 'Started a fresh bay' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'OK' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('\u2014')
  })

  it('does not call an upgraded bay a fresh one', () => {
    render(
      <StateRecoveryModal
        health={{
          ok: true,
          notice: 'MechBay could not move some mission logs out of your old save.'
        }}
        onDismiss={() => {}}
      />
    )
    expect(screen.getByRole('alertdialog', { name: 'Upgraded your saved bay' })).toBeTruthy()
    expect(document.body.textContent).not.toContain('fresh')
  })
})
