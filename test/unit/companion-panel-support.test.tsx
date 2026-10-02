// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'
import { CompanionPanel } from '../../src/renderer/src/components/CompanionPanel'
import type { Companion } from '../../src/shared/types'

afterEach(cleanup)

const atlas: Companion = {
  id: 'atlas',
  family: 'claude',
  mechClass: 'atlas',
  name: 'Atlas-Prime',
  spriteKey: 'atlas',
  homeTile: { x: 0, y: 0 },
  cliAvailable: true,
  soulPath: '/souls/atlas/soul.md',
  memoryPath: '/souls/atlas/memory.md'
}
const NOTE = 'Bring your own key. Not verified by the author.'

describe('CompanionPanel runtime note', () => {
  it('tells the user a Gemini mech is bring your own key and unverified', () => {
    const catapult = {
      ...atlas,
      id: 'catapult',
      family: 'gemini' as const,
      mechClass: 'catapult' as const,
      name: 'Catapult-Prime'
    }
    render(<CompanionPanel companion={catapult} deployments={[]} facilities={[]} />)
    expect(screen.getByText(NOTE)).toBeTruthy()
  })

  it('shows no note for a runtime the author verifies', () => {
    render(<CompanionPanel companion={atlas} deployments={[]} facilities={[]} />)
    expect(screen.queryByText(/Not verified by the author/)).toBeNull()
  })

  it('follows the runtime override, not the native family', () => {
    render(
      <CompanionPanel companion={{ ...atlas, runtime: 'kimi' }} deployments={[]} facilities={[]} />
    )
    expect(screen.getByText(NOTE)).toBeTruthy()
  })
})
