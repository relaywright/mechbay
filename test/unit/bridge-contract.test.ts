// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { MechbayBridge } from '../../src/shared/bridge'
import { missionStateOf } from '../../src/shared/bridge'
import { IPC } from '../../src/shared/ipc-channels'
import type { DeploymentStatus, LogChunk } from '../../src/shared/types'

const electron = vi.hoisted(() => {
  const listeners = new Map<string, (event: unknown, payload: unknown) => void>()
  return {
    listeners,
    exposed: {} as Record<string, unknown>,
    ipcRenderer: {
      invoke: vi.fn(async (channel: string, ...args: unknown[]) => ({ channel, args })),
      on: vi.fn((channel: string, fn: (event: unknown, payload: unknown) => void) =>
        listeners.set(channel, fn)
      ),
      removeListener: vi.fn((channel: string) => listeners.delete(channel))
    }
  }
})

vi.mock('electron', () => ({
  contextBridge: {
    exposeInMainWorld: (key: string, api: unknown) => (electron.exposed[key] = api)
  },
  ipcRenderer: electron.ipcRenderer
}))

describe('MechbayBridge preload', () => {
  let bridge: MechbayBridge
  beforeEach(async () => {
    vi.resetModules()
    Object.defineProperty(process, 'contextIsolated', { value: true, configurable: true })
    await import('../../src/preload/index')
    bridge = electron.exposed.mechbay as MechbayBridge
  })

  it('exposes logs.history over the LOG_HISTORY channel', async () => {
    await bridge.logs.history('01J9Z1D0EP000000000000005', 40)
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(
      IPC.LOG_HISTORY,
      '01J9Z1D0EP000000000000005',
      40
    )
  })

  it('delivers log entries to subscribers as arrays and unsubscribes cleanly', () => {
    const seen: LogChunk[][] = []
    const off = bridge.logs.subscribe((entries) => seen.push(entries))
    const entry = { id: 'm:1', deploymentId: 'm', timestamp: 1, stream: 'stdout', text: 'hi' }
    electron.listeners.get(IPC.LOG_STREAM)?.({}, entry)
    expect(seen).toEqual([[entry]])
    off()
    expect(electron.ipcRenderer.removeListener).toHaveBeenCalledWith(
      IPC.LOG_STREAM,
      expect.any(Function)
    )
  })

  it('exposes review and abort under their spec names', async () => {
    await bridge.review.approve('m1')
    await bridge.review.reject('m1')
    await bridge.deployAbort('m1')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC.REVIEW_APPROVE, 'm1')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC.REVIEW_REJECT, 'm1')
    expect(electron.ipcRenderer.invoke).toHaveBeenCalledWith(IPC.DEPLOY_ABORT, 'm1')
  })
})

describe('missionStateOf', () => {
  it.each<[DeploymentStatus, string]>([
    ['queued', 'queued'],
    ['walking-to', 'running'],
    ['working', 'running'],
    ['awaiting-input', 'running'],
    ['returning', 'running'],
    ['completed', 'done'],
    ['failed', 'failed'],
    ['cancelled', 'cancelled']
  ])('maps %s to %s', (status, expected) => {
    expect(missionStateOf(status)).toBe(expected)
  })
})
