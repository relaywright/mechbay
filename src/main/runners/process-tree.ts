import { spawn as nodeSpawn, type ChildProcess } from 'child_process'
import path from 'path'

export interface KillTreeDeps {
  platform?: NodeJS.Platform
  spawnProcess?: typeof nodeSpawn
  killProcess?: (pid: number, signal: NodeJS.Signals | 0) => void
  /** POSIX: how long to wait after SIGTERM before SIGKILL. */
  graceMs?: number
  /** Upper bound on waiting for the process to report its exit. */
  waitMs?: number
}

/** `== null` on purpose: test doubles may leave these undefined. */
export function isRunning(child: Pick<ChildProcess, 'exitCode' | 'signalCode'>): boolean {
  return child.exitCode == null && child.signalCode == null
}

const delay = (ms: number): Promise<void> =>
  new Promise((r) => {
    setTimeout(r, ms).unref?.()
  })

/**
 * taskkill by absolute path, so a stray taskkill.exe in the working folder
 * or early on PATH is never the one that runs.
 */
function taskkillPath(): string {
  return path.win32.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'taskkill.exe')
}

/** ChildProcess.kill is a no-op once Node has seen the child exit, so it never reaches a reused PID. */
function killChildOnly(child: ChildProcess, signal?: NodeJS.Signals): void {
  try {
    child.kill(signal)
  } catch {
    // already gone
  }
}

/**
 * End a child process and everything it started (P0-11). Windows: taskkill
 * on the whole tree, because the child MechBay holds is usually cmd.exe
 * running an npm shim. POSIX: the child leads its own process group
 * (spawned with detached: true), so the group gets SIGTERM, then SIGKILL.
 * Never rejects; resolves once the child has exited or `waitMs` has passed.
 */
export async function killProcessTree(child: ChildProcess, deps: KillTreeDeps = {}): Promise<void> {
  const pid = child.pid
  // PID 0 and 1 (and a negative group id built from them) would signal far
  // more than MechBay's own child, so they are never acted on.
  if (pid === undefined || !Number.isInteger(pid) || pid <= 1 || !isRunning(child)) return
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
  const waitMs = deps.waitMs ?? 10_000

  if ((deps.platform ?? process.platform) === 'win32') {
    const taskkillDone = new Promise<void>((resolve) => {
      const killer = (deps.spawnProcess ?? nodeSpawn)(
        taskkillPath(),
        ['/PID', String(pid), '/T', '/F'],
        { windowsHide: true, stdio: 'ignore' }
      )
      killer.once('exit', (code) => {
        // A non-zero code can mean part of the tree was already gone; make
        // sure the process MechBay holds is not one of the survivors.
        if (code !== 0 && isRunning(child)) killChildOnly(child)
        resolve()
      })
      killer.once('error', (err) => {
        console.warn('[process-tree] taskkill failed; falling back to killing the child only:', err)
        killChildOnly(child)
        resolve()
      })
    })
    await Promise.race([taskkillDone.then(() => exited), delay(waitMs)])
    return
  }

  const kill = deps.killProcess ?? ((p: number, s: NodeJS.Signals | 0) => process.kill(p, s))
  const signalGroup = (signal: NodeJS.Signals): void => {
    try {
      kill(-pid, signal)
    } catch {
      // No such group (already gone, or the child was not started as a group
      // leader): signal the child itself.
      killChildOnly(child, signal)
    }
  }
  const treeAlive = (): boolean => {
    try {
      kill(-pid, 0)
      return true
    } catch {
      return isRunning(child)
    }
  }

  signalGroup('SIGTERM')
  const graceEnds = Date.now() + (deps.graceMs ?? 5000)
  while (Date.now() < graceEnds && treeAlive()) await delay(100)
  if (treeAlive()) signalGroup('SIGKILL')
  await Promise.race([exited, delay(waitMs)])
}
