// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { JournalTab } from '../../src/renderer/src/components/JournalTab'

type ReadResult = { ok: true; content: string } | { ok: false; error: string }

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

afterEach(() => {
  cleanup()
  Reflect.deleteProperty(window, 'mechbay')
})

describe('JournalTab', () => {
  it("never shows or saves one mech's soul under another mech", async () => {
    const soul = { atlas: deferred<ReadResult>(), raven: deferred<ReadResult>() }
    const soulWrite = vi.fn(async () => ({ ok: true as const }))
    Object.assign(window, {
      mechbay: {
        soulRead: (id: 'atlas' | 'raven') => soul[id].promise,
        memoryRead: () => new Promise(() => {}),
        soulWrite
      }
    })

    const { rerender } = render(<JournalTab companionId="atlas" />)
    rerender(<JournalTab companionId="raven" />)
    expect((screen.getByRole('button', { name: 'SAVE' }) as HTMLButtonElement).disabled).toBe(true)

    await act(async () => soul.raven.resolve({ ok: true, content: 'Raven soul' }))
    await act(async () => soul.atlas.resolve({ ok: true, content: 'Atlas soul' }))

    expect((screen.getByRole('textbox') as HTMLTextAreaElement).value).toBe('Raven soul')
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'SAVE' }))
    })
    expect(soulWrite).toHaveBeenCalledWith('raven', 'Raven soul')
  })
})
