// @vitest-environment happy-dom
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DeployModal } from '../../src/renderer/src/components/DeployModal'
import type { Companion, Facility } from '../../src/shared/types'

afterEach(cleanup)

const companion: Companion = {
  id: 'atlas',
  family: 'claude',
  mechClass: 'atlas',
  name: 'Atlas-Prime',
  spriteKey: 'atlas',
  homeTile: { x: 0, y: 0 },
  cliAvailable: true,
  soulPath: '/souls/atlas/soul.md',
  memoryPath: '/souls/atlas/memory.md',
  autonomy: 'edit'
}

const facility: Facility = {
  id: 'reactor',
  name: 'reactor-control',
  path: '/projects/reactor-control',
  facilityType: 'research-lab',
  tile: { x: 4, y: 4 },
  source: 'manual',
  discoveredAt: 0
}

describe('DeployModal keyboard submit', () => {
  it('Ctrl+Enter calls the latest onDeploy after a re-render', () => {
    const onCancel = vi.fn()
    const first = vi.fn()
    const second = vi.fn()
    const { rerender } = render(
      <DeployModal companion={companion} facility={facility} onDeploy={first} onCancel={onCancel} />
    )
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Tidy the README' } })
    rerender(
      <DeployModal
        companion={companion}
        facility={facility}
        onDeploy={second}
        onCancel={onCancel}
      />
    )
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })

    expect(second).toHaveBeenCalledWith('Tidy the README', undefined)
    expect(first).not.toHaveBeenCalled()
  })

  it('Ctrl+Enter does nothing while the prompt is empty', () => {
    const onDeploy = vi.fn()
    render(
      <DeployModal
        companion={companion}
        facility={facility}
        onDeploy={onDeploy}
        onCancel={vi.fn()}
      />
    )
    fireEvent.keyDown(window, { key: 'Enter', ctrlKey: true })
    expect(onDeploy).not.toHaveBeenCalled()
  })
})
