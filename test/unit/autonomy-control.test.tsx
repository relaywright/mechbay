// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { AutonomyControl } from '../../src/renderer/src/components/AutonomyControl'

afterEach(cleanup)

describe('AutonomyControl', () => {
  it('shows three levels and changes level on click', () => {
    const onChange = vi.fn()
    render(<AutonomyControl runtime="claude" value="edit" onChange={onChange} />)
    expect(screen.getByRole('radio', { name: 'Edit files' }).getAttribute('aria-checked')).toBe(
      'true'
    )
    fireEvent.click(screen.getByRole('radio', { name: 'Full' }))
    expect(onChange).toHaveBeenCalledWith('full')
  })

  it('disables levels a runtime cannot enforce and says why', () => {
    render(<AutonomyControl runtime="gemini" value="edit" onChange={() => {}} />)
    expect((screen.getByRole('radio', { name: 'Read only' }) as HTMLButtonElement).disabled).toBe(
      true
    )
    expect(screen.getByRole('radio', { name: 'Full' }).getAttribute('aria-checked')).toBe('true')
    expect(screen.getByText(/every action approved/)).toBeTruthy()
  })

  it('shows "Not enforced" for runtimes MechBay cannot limit', () => {
    render(<AutonomyControl runtime="hermes" value="edit" onChange={() => {}} />)
    expect(screen.getByText(/Not enforced/)).toBeTruthy()
    expect(screen.getAllByRole('radio').every((r) => (r as HTMLButtonElement).disabled)).toBe(true)
  })
})
