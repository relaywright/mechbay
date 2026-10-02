// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'

// Vitest runs with globals off, so Testing Library cannot register its own
// cleanup. Every DOM test file calls cleanup itself.
afterEach(cleanup)

it('renders React components in the DOM test environment', () => {
  render(<button type="button">Deploy</button>)
  expect(screen.getByRole('button', { name: 'Deploy' })).toBeTruthy()
})
