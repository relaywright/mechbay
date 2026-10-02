// @vitest-environment happy-dom
import { cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogPane } from '../../src/renderer/src/components/LogPane'
import type { LogChunk } from '../../src/shared/types'

const window_ = (from: number, count: number): LogChunk[] =>
  Array.from({ length: count }, (_, i) => ({
    id: `dep-1:${from + i}`,
    deploymentId: 'dep-1',
    seq: from + i,
    timestamp: 1_000 + from + i,
    stream: 'stdout',
    text: `line ${from + i}`
  }))

describe('LogPane auto-scroll', () => {
  let scrollTo: ReturnType<typeof vi.fn>

  beforeEach(() => {
    scrollTo = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
      configurable: true,
      value: scrollTo
    })
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
  })

  afterEach(() => {
    cleanup()
    vi.unstubAllGlobals()
  })

  it('keeps following new lines once the view is full and the count stops growing', () => {
    const { rerender } = render(<LogPane logs={window_(1, 2000)} />)
    const before = scrollTo.mock.calls.length
    expect(before).toBeGreaterThan(0)

    // At the cap the renderer drops the oldest line for every new one, so
    // the count stays at 2000 while the newest id changes.
    rerender(<LogPane logs={window_(2, 2000)} />)
    expect(scrollTo.mock.calls.length).toBe(before + 1)
  })

  it('does not scroll again when the same lines re-render', () => {
    const logs = window_(1, 10)
    const { rerender } = render(<LogPane logs={logs} />)
    const before = scrollTo.mock.calls.length
    rerender(<LogPane logs={[...logs]} />)
    expect(scrollTo.mock.calls.length).toBe(before)
  })
})
