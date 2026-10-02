import { describe, expect, it, vi } from 'vitest'
import { readUntilExitDrained } from '../../src/main/drain-output'

async function collect<T>(source: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = []
  for await (const item of source) out.push(item)
  return out
}

/** Output that a leftover process keeps open: yields its lines, then never ends. */
async function* heldOpen(lines: string[]): AsyncGenerator<string> {
  yield* lines
  await new Promise(() => {})
}

describe('readUntilExitDrained', () => {
  it('passes every line through when the output closes normally', async () => {
    async function* closes(): AsyncGenerator<string> {
      yield 'Reading src/index.ts'
      yield 'Done.'
    }
    const onCutOff = vi.fn()
    expect(await collect(readUntilExitDrained(closes(), Promise.resolve(0), 50, onCutOff))).toEqual(
      ['Reading src/index.ts', 'Done.']
    )
    expect(onCutOff).not.toHaveBeenCalled()
  })

  it('stops reading a grace period after the agent exits when a leftover process holds the output open', async () => {
    const onCutOff = vi.fn()
    const started = Date.now()
    const lines = await collect(
      readUntilExitDrained(
        heldOpen(['npm run dev &', 'Agent finished.']),
        Promise.resolve(0),
        50,
        onCutOff
      )
    )
    expect(lines).toEqual(['npm run dev &', 'Agent finished.'])
    expect(onCutOff).toHaveBeenCalledTimes(1)
    expect(Date.now() - started).toBeLessThan(2000)
  })

  it('keeps reading for as long as the agent is still running', async () => {
    let exit!: (code: number) => void
    const exited = new Promise<number>((r) => (exit = r))
    const onCutOff = vi.fn()
    const reading = collect(readUntilExitDrained(heldOpen(['working']), exited, 20, onCutOff))
    await new Promise((r) => setTimeout(r, 100))
    expect(onCutOff).not.toHaveBeenCalled()
    exit(0)
    expect(await reading).toEqual(['working'])
    expect(onCutOff).toHaveBeenCalledTimes(1)
  })

  it('still reports an error from the output stream', async () => {
    async function* breaks(): AsyncGenerator<string> {
      yield 'partial'
      throw new Error('output pipe broke')
    }
    await expect(
      collect(readUntilExitDrained(breaks(), new Promise(() => {}), 50))
    ).rejects.toThrow('output pipe broke')
  })
})
