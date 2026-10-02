/**
 * Read an agent's output until it closes, or until `graceMs` after the agent
 * itself exits, whichever comes first.
 *
 * A runner's output only closes once every process holding the pipe has
 * exited. A process the agent left running (a dev server started in the
 * background, or a tool that escaped a recall) can hold it open long after
 * the agent is gone, and the mission would then never finish. The grace
 * period lets the last lines arrive before reading stops.
 *
 * Errors from the output still reach the caller. `onCutOff` runs once when
 * reading stops early.
 */
export async function* readUntilExitDrained<T>(
  output: AsyncIterable<T>,
  exit: Promise<unknown>,
  graceMs: number,
  onCutOff?: () => void
): AsyncGenerator<T> {
  const iterator = output[Symbol.asyncIterator]()
  let finished = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const cutOff = new Promise<'cut-off'>((resolve) => {
    const startGrace = (): void => {
      if (!finished) timer = setTimeout(() => resolve('cut-off'), graceMs)
    }
    exit.then(startGrace, startGrace)
  })
  try {
    for (;;) {
      // Promise.race subscribes to the pending read, so if it rejects after
      // a cut-off the rejection is still handled.
      const next = await Promise.race([iterator.next(), cutOff])
      if (next === 'cut-off') {
        onCutOff?.()
        return
      }
      if (next.done) return
      yield next.value
    }
  } finally {
    finished = true
    clearTimeout(timer)
  }
}
