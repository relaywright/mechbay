// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SettingsModal } from '../../src/renderer/src/components/SettingsModal'
import type { Companion } from '../../src/shared/types'

const configureCompanion = vi.fn(async () => ({ ok: true as const, cliAvailable: true }))

beforeEach(() => {
  configureCompanion.mockClear()
  Object.assign(window, {
    mechbay: {
      configureCompanion,
      secretsStatus: vi.fn(async () => ({
        claude: false,
        codex: false,
        kimi: false,
        gemini: false,
        hermes: false
      })),
      updateSettings: vi.fn(),
      secretsSet: vi.fn(),
      fieldReset: vi.fn()
    }
  })
})
afterEach(cleanup)

const atlas = {
  id: 'atlas',
  name: 'Atlas',
  family: 'claude',
  mechClass: 'scout',
  autonomy: 'read',
  cliAvailable: true
} as unknown as Companion

function renderSettings(): void {
  render(
    <SettingsModal
      companions={[atlas]}
      reduceMotion={false}
      crtOverlay={false}
      missionAlerts={false}
      onClose={() => {}}
    />
  )
}

function pickRuntime(value: string): void {
  fireEvent.change(screen.getByDisplayValue('CLAUDE CODE'), { target: { value } })
  fireEvent.click(screen.getByText('APPLY'))
}

describe('Mech Settings runtime switch', () => {
  it('asks before a switch raises a Read only mech to Full, and sends the confirmed level', async () => {
    renderSettings()
    pickRuntime('gemini')

    const alert = screen.getByRole('alert', { name: 'Confirm runtime switch' })
    expect(alert.textContent).toContain('On GEMINI CLI, this mech runs at Full')
    expect(configureCompanion).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'SWITCH ANYWAY' }))
    await waitFor(() =>
      expect(configureCompanion).toHaveBeenCalledWith({
        companionId: 'atlas',
        runtime: 'gemini',
        model: '',
        acceptAutonomy: 'full'
      })
    )
  })

  it('CANCEL leaves the mech alone', () => {
    renderSettings()
    pickRuntime('hermes')
    expect(screen.getByRole('alert').textContent).toContain(
      'MechBay cannot limit what this mech does'
    )

    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }))
    expect(screen.queryByRole('alert')).toBeNull()
    expect(configureCompanion).not.toHaveBeenCalled()
  })

  it('switches without asking when the level does not go up', async () => {
    renderSettings()
    pickRuntime('codex')
    expect(screen.queryByRole('alert')).toBeNull()
    await waitFor(() =>
      expect(configureCompanion).toHaveBeenCalledWith({
        companionId: 'atlas',
        runtime: 'codex',
        model: ''
      })
    )
  })
})
