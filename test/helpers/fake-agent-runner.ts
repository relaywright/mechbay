import path from 'path'
import { CliRunner, type CliRunnerDeps } from '../../src/main/runners/base'
import type { RunnerChunk } from '../../src/main/runners/types'

const DIR = path.join(__dirname, '../fixtures/process-tree')

/**
 * A real CLI runner whose "agent" is parent.cjs, launched the way MechBay
 * launches real CLIs: through a .cmd shim on Windows, through a shell
 * elsewhere, so the agent is a grandchild of the process MechBay holds.
 */
export class FakeAgentRunner extends CliRunner {
  constructor(deps: Partial<CliRunnerDeps> = {}) {
    super({ which: async () => 'fake', ...deps })
  }

  protected get command(): string {
    return process.platform === 'win32' ? path.join(DIR, 'fake-agent.cmd') : 'sh'
  }

  protected buildArgs(): string[] {
    return process.platform === 'win32'
      ? []
      : ['-c', `node "${path.join(DIR, 'parent.cjs')}"; exit $?`]
  }
}

/** Read the stream until both PIDs are printed. Leaves the rest of the stream unread. */
export async function readPids(
  stream: AsyncIterable<RunnerChunk>
): Promise<{ parent: number; child: number }> {
  let text = ''
  for await (const chunk of stream) {
    text += chunk.text
    const parent = /PARENT_PID=(\d+)/.exec(text)
    const child = /CHILD_PID=(\d+)/.exec(text)
    if (parent && child) return { parent: Number(parent[1]), child: Number(child[1]) }
  }
  throw new Error(`agent exited before printing its PIDs:\n${text}`)
}

export function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export async function waitUntilDead(pids: number[], ms: number): Promise<number[]> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const alive = pids.filter(isAlive)
    if (alive.length === 0) return []
    await new Promise((r) => setTimeout(r, 100))
  }
  return pids.filter(isAlive)
}
