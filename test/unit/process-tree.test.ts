import { EventEmitter } from 'events'
import { afterEach, describe, expect, it, vi, type Mock } from 'vitest'
import { isRunning, killProcessTree } from '../../src/main/runners/process-tree'

type FakeChild = EventEmitter & {
  pid: number | undefined
  exitCode: number | null
  signalCode: string | null
  kill: Mock
}

function fakeChild(pid = 4242): FakeChild {
  return Object.assign(new EventEmitter(), {
    pid: pid as number | undefined,
    exitCode: null as number | null,
    signalCode: null as string | null,
    kill: vi.fn()
  })
}

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('killProcessTree', () => {
  it('uses taskkill /T /F on Windows', async () => {
    const child = fakeChild()
    const spawnProcess = vi.fn(() => {
      const killer = new EventEmitter()
      queueMicrotask(() => {
        killer.emit('exit', 0)
        child.exitCode = 1
        child.emit('exit', 1)
      })
      return killer
    })
    await killProcessTree(child as never, {
      platform: 'win32',
      spawnProcess: spawnProcess as never
    })
    expect(spawnProcess).toHaveBeenCalledWith(
      expect.stringMatching(/(^|[\\/])taskkill\.exe$/i),
      ['/PID', '4242', '/T', '/F'],
      expect.objectContaining({ windowsHide: true })
    )
  })

  it('stops the child alone, and still resolves, when taskkill cannot start', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const child = fakeChild()
    child.kill.mockImplementation(() => {
      throw new Error('kill failed')
    })
    const spawnProcess = vi.fn(() => {
      const killer = new EventEmitter()
      queueMicrotask(() => killer.emit('error', new Error('spawn taskkill ENOENT')))
      return killer
    })
    await killProcessTree(child as never, {
      platform: 'win32',
      spawnProcess: spawnProcess as never,
      waitMs: 10
    })
    expect(child.kill).toHaveBeenCalledTimes(1)
  })

  it('signals the process group on POSIX, then forces it after the grace period', async () => {
    vi.useFakeTimers()
    const child = fakeChild()
    const sent: [number, string | number][] = []
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      sent.push([pid, signal])
    })
    const done = killProcessTree(child as never, {
      platform: 'linux',
      killProcess,
      graceMs: 1000,
      waitMs: 2000
    })
    await vi.advanceTimersByTimeAsync(3000)
    await done
    expect(sent.filter(([, s]) => s !== 0)).toEqual([
      [-4242, 'SIGTERM'],
      [-4242, 'SIGKILL']
    ])
  })

  it('skips SIGKILL on POSIX when the group ends within the grace period', async () => {
    const child = fakeChild()
    const sent: [number, string | number][] = []
    const killProcess = vi.fn((pid: number, signal: NodeJS.Signals | 0) => {
      sent.push([pid, signal])
      if (signal === 0) throw Object.assign(new Error('gone'), { code: 'ESRCH' })
      if (signal === 'SIGTERM') {
        child.signalCode = 'SIGTERM'
        child.emit('exit', null, 'SIGTERM')
      }
    })
    await killProcessTree(child as never, { platform: 'linux', killProcess, graceMs: 1000 })
    expect(sent.filter(([, s]) => s !== 0)).toEqual([[-4242, 'SIGTERM']])
  })

  it('never signals a process group for PID 0 or 1', async () => {
    for (const pid of [0, 1]) {
      const child = fakeChild(pid)
      const killProcess = vi.fn()
      const spawnProcess = vi.fn()
      await killProcessTree(child as never, { platform: 'linux', killProcess, waitMs: 10 })
      await killProcessTree(child as never, {
        platform: 'win32',
        spawnProcess: spawnProcess as never,
        waitMs: 10
      })
      expect(killProcess).not.toHaveBeenCalled()
      expect(spawnProcess).not.toHaveBeenCalled()
    }
  })

  it('does nothing for a process that already exited', async () => {
    const child = fakeChild()
    child.exitCode = 0
    const spawnProcess = vi.fn()
    await killProcessTree(child as never, {
      platform: 'win32',
      spawnProcess: spawnProcess as never
    })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(isRunning(child as never)).toBe(false)
  })

  it('does nothing for a process that never started (no PID)', async () => {
    const child = fakeChild()
    child.pid = undefined
    const spawnProcess = vi.fn()
    const killProcess = vi.fn()
    await killProcessTree(child as never, {
      platform: 'win32',
      spawnProcess: spawnProcess as never
    })
    await killProcessTree(child as never, { platform: 'linux', killProcess })
    expect(spawnProcess).not.toHaveBeenCalled()
    expect(killProcess).not.toHaveBeenCalled()
  })
})
