import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest'
import type { BrowserWindow } from 'electron'
import type { AppState, Companion, Deployment, Facility } from '../../src/shared/types'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

vi.mock('electron', () => ({
  Notification: class {
    static isSupported(): boolean {
      return true
    }
    on = vi.fn()
    show = vi.fn()
  }
}))

import {
  detectMissionEvents,
  formatMissionAlert,
  MissionAlerts,
  type NotifyOptions
} from '../../src/main/mission-alerts'

function deployment(overrides: Partial<Deployment>): Deployment {
  return {
    id: overrides.id ?? 'dep-1',
    companionId: 'atlas',
    facilityId: 'fac-lab',
    taskPrompt: 'Ship the feature',
    status: 'working',
    startedAt: 1_000,
    ...overrides
  }
}

const COMPANION: Companion = {
  id: 'atlas',
  family: 'claude',
  mechClass: 'atlas',
  name: 'Atlas-Prime',
  spriteKey: 'mech-atlas',
  homeTile: { x: 4, y: 10 },
  cliAvailable: true,
  soulPath: '/tmp/atlas/soul.md',
  memoryPath: '/tmp/atlas/memory.md'
}

const FACILITY: Facility = {
  id: 'fac-lab',
  name: 'Research Lab',
  path: '/tmp/lab',
  facilityType: 'research-lab',
  tile: { x: 8, y: 3 },
  source: 'manual',
  discoveredAt: 0
}

function baseState(overrides: Partial<AppState> = {}): Pick<AppState, 'companions' | 'facilities'> {
  return { companions: [COMPANION], facilities: [FACILITY], ...overrides }
}

describe('detectMissionEvents', () => {
  it('fires for a status transitioning into completed', () => {
    const prev = [deployment({ status: 'working' })]
    const next = [deployment({ status: 'completed' })]
    const events = detectMissionEvents(prev, next)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({ status: 'completed' })
  })

  it('fires for failed and awaiting-input transitions too', () => {
    const prev = [
      deployment({ id: 'd1', status: 'working' }),
      deployment({ id: 'd2', status: 'walking-to' })
    ]
    const next = [
      deployment({ id: 'd1', status: 'failed' }),
      deployment({ id: 'd2', status: 'awaiting-input' })
    ]
    const events = detectMissionEvents(prev, next)
    expect(events.map((e) => e.status).sort()).toEqual(['awaiting-input', 'failed'])
  })

  it('counts a brand-new deployment already in a firable state', () => {
    const events = detectMissionEvents([], [deployment({ status: 'completed' })])
    expect(events).toHaveLength(1)
  })

  it('does not re-fire when the status is unchanged', () => {
    const prev = [deployment({ status: 'completed' })]
    const next = [deployment({ status: 'completed' })]
    expect(detectMissionEvents(prev, next)).toHaveLength(0)
  })

  it('ignores transitions into non-firable statuses like queued or cancelled', () => {
    const prev = [deployment({ status: 'working' })]
    const next = [deployment({ status: 'cancelled' })]
    expect(detectMissionEvents(prev, next)).toHaveLength(0)
  })
})

describe('formatMissionAlert', () => {
  it('formats a completed mission with diff stats', () => {
    const event = {
      status: 'completed' as const,
      deployment: deployment({
        status: 'completed',
        diffStats: { filesChanged: 2, insertions: 14, deletions: 3 }
      })
    }
    const { title, body } = formatMissionAlert(event, baseState())
    expect(title).toBe('Atlas-Prime returned')
    expect(body).toBe('Research Lab · 2 files changed, +14 −3')
  })

  it('formats a failed mission using the failure summary', () => {
    const event = {
      status: 'failed' as const,
      deployment: deployment({ status: 'failed', summary: 'Failed. Exit 1.' })
    }
    const { title, body } = formatMissionAlert(event, baseState())
    expect(title).toBe('Atlas-Prime is down')
    expect(body).toBe('Failed. Exit 1.')
  })

  it('formats an awaiting-input mission', () => {
    const event = {
      status: 'awaiting-input' as const,
      deployment: deployment({ status: 'awaiting-input' })
    }
    const { title, body } = formatMissionAlert(event, baseState())
    expect(title).toBe('Atlas-Prime needs input')
    expect(body).toBe('Research Lab · Waiting for your input.')
  })

  it('truncates long bodies to roughly 120 characters', () => {
    const longSummary = 'x'.repeat(200)
    const event = {
      status: 'failed' as const,
      deployment: deployment({ status: 'failed', summary: longSummary })
    }
    const { body } = formatMissionAlert(event, baseState())
    expect(body.length).toBeLessThanOrEqual(120)
    expect(body.endsWith('…')).toBe(true)
  })

  it('degrades gracefully when the companion or facility is missing', () => {
    const event = {
      status: 'completed' as const,
      deployment: deployment({ companionId: 'ghost', facilityId: 'ghost-fac', status: 'completed' })
    }
    const { title, body } = formatMissionAlert(event, { companions: [], facilities: [] })
    expect(title).toBe('Unknown mech returned')
    expect(body).toContain('an unlinked facility')
  })
})

describe('MissionAlerts', () => {
  function setup(initialDeployments: Deployment[] = []): {
    state: StateManager
    win: {
      isDestroyed: ReturnType<typeof vi.fn>
      isFocused: ReturnType<typeof vi.fn>
      isMinimized: ReturnType<typeof vi.fn>
      restore: ReturnType<typeof vi.fn>
      focus: ReturnType<typeof vi.fn>
      flashFrame: ReturnType<typeof vi.fn>
      setProgressBar: ReturnType<typeof vi.fn>
      on: ReturnType<typeof vi.fn>
    }
    notify: Mock<(opts: NotifyOptions) => void>
  } {
    const data: Record<string, unknown> = {}
    const store: StoreLike = {
      get: (key) => data[key],
      set: (key, value) => {
        data[key] = value
      },
      has: (key) => key in data
    }
    const state = new StateManager(store, '/tmp/mission-alerts')
    state.updateState((prev) => ({
      ...prev,
      companions: [COMPANION],
      facilities: [FACILITY],
      deployments: initialDeployments
    }))

    const win = {
      isDestroyed: vi.fn(() => false),
      isFocused: vi.fn(() => false),
      isMinimized: vi.fn(() => false),
      restore: vi.fn(),
      focus: vi.fn(),
      flashFrame: vi.fn(),
      setProgressBar: vi.fn(),
      on: vi.fn()
    }
    const notify = vi.fn<(opts: NotifyOptions) => void>()
    return { state, win, notify }
  }

  beforeEach(() => vi.clearAllMocks())

  it('notifies only when the window is unfocused', async () => {
    const { state, win, notify } = setup([deployment({ status: 'working' })])
    win.isFocused.mockReturnValue(false)
    const { MissionAlerts: MA } = await import('../../src/main/mission-alerts')
    new MA({ win: win as unknown as BrowserWindow, state, notify })

    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => ({ ...d, status: 'completed' as const }))
    }))

    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ title: 'Atlas-Prime returned' })
    expect(win.flashFrame).toHaveBeenCalledWith(true)
  })

  it('does not notify when the window is focused', () => {
    const { state, win, notify } = setup([deployment({ status: 'working' })])
    win.isFocused.mockReturnValue(true)
    win.isMinimized.mockReturnValue(false)
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })

    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => ({ ...d, status: 'completed' as const }))
    }))

    expect(notify).not.toHaveBeenCalled()
    expect(win.flashFrame).not.toHaveBeenCalled()
  })

  it('respects missionAlerts: false in settings', () => {
    const { state, win, notify } = setup([deployment({ status: 'working' })])
    win.isFocused.mockReturnValue(false)
    state.updateState((prev) => ({ ...prev, settings: { ...prev.settings, missionAlerts: false } }))
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })

    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => ({ ...d, status: 'completed' as const }))
    }))

    expect(notify).not.toHaveBeenCalled()
  })

  it('does not fire for deployments already completed at construction time', () => {
    const { state, win, notify } = setup([deployment({ status: 'completed' })])
    win.isFocused.mockReturnValue(false)
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })

    // An unrelated state change (e.g. a settings toggle) should not
    // resurrect the pre-existing completed deployment as a "new" alert.
    state.updateState((prev) => ({ ...prev, settings: { ...prev.settings, crtOverlay: false } }))

    expect(notify).not.toHaveBeenCalled()
  })

  it('restores and focuses the window when a notification is clicked', () => {
    const { state, win, notify } = setup([deployment({ status: 'working' })])
    win.isFocused.mockReturnValue(false)
    win.isMinimized.mockReturnValue(true)
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })

    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => ({ ...d, status: 'completed' as const }))
    }))

    const onClick = notify.mock.calls[0][0].onClick as () => void
    onClick()
    expect(win.restore).toHaveBeenCalled()
    expect(win.focus).toHaveBeenCalled()
  })

  it('toggles the taskbar progress bar only when the active/idle state changes', () => {
    const { state, win, notify } = setup([])
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })
    // No active deployments at construction -> setProgressBar(-1) once.
    expect(win.setProgressBar).toHaveBeenCalledTimes(1)
    expect(win.setProgressBar).toHaveBeenLastCalledWith(-1)

    state.updateState((prev) => ({ ...prev, deployments: [deployment({ status: 'working' })] }))
    expect(win.setProgressBar).toHaveBeenCalledTimes(2)
    expect(win.setProgressBar).toHaveBeenLastCalledWith(1, { mode: 'indeterminate' })

    // Another active deployment added while already active -> no extra call.
    state.updateState((prev) => ({
      ...prev,
      deployments: [...prev.deployments, deployment({ id: 'd2', status: 'walking-to' })]
    }))
    expect(win.setProgressBar).toHaveBeenCalledTimes(2)

    state.updateState((prev) => ({
      ...prev,
      deployments: prev.deployments.map((d) => ({ ...d, status: 'completed' as const }))
    }))
    expect(win.setProgressBar).toHaveBeenCalledTimes(3)
    expect(win.setProgressBar).toHaveBeenLastCalledWith(-1)
  })

  it('clears the taskbar flash on window focus', () => {
    const { state, win, notify } = setup([])
    new MissionAlerts({ win: win as unknown as BrowserWindow, state, notify })
    const focusHandler = win.on.mock.calls.find((call) => call[0] === 'focus')?.[1] as () => void
    expect(focusHandler).toBeTypeOf('function')
    focusHandler()
    expect(win.flashFrame).toHaveBeenCalledWith(false)
  })
})
