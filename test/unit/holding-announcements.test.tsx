// @vitest-environment happy-dom
import { act, cleanup, render } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AppState, Deployment } from '../../src/shared/types'
import { CockpitHud } from '../../src/renderer/src/components/CockpitHud'
import { CommsFeed } from '../../src/renderer/src/components/CommsFeed'

vi.mock('../../src/renderer/src/audio/sfx', () => ({ sfx: { play: vi.fn() } }))

// The lance holds one mission at a time (cap 1). Atlas is out; Raven's new
// mission really waits, so a HOLDING line is announced, but only after the
// line ahead of it, and Raven may set off before its turn on screen comes.
function deployment(id: string, companionId: string, status: Deployment['status']): Deployment {
  return {
    id,
    companionId,
    facilityId: 'lab',
    taskPrompt: 'Survey the reactor.',
    status,
    startedAt: 1
  } as Deployment
}

function bay(deployments: Deployment[]): AppState {
  return {
    companions: [
      { id: 'atlas-1', name: 'Atlas-Prime', mechClass: 'atlas' },
      { id: 'raven-1', name: 'Raven-Prime', mechClass: 'raven' }
    ],
    facilities: [{ id: 'lab', name: 'Research Lab', path: '/projects/lab' }],
    deployments,
    settings: { concurrencyCap: 1 }
  } as unknown as AppState
}

const AT_START = bay([deployment('d1', 'atlas-1', 'working')])
// Atlas asks for input (announced first) as Raven's mission joins the line.
const RAVEN_WAITS = bay([
  deployment('d1', 'atlas-1', 'awaiting-input'),
  deployment('d2', 'raven-1', 'queued')
])
// Atlas finishes and Raven takes the free slot.
const RAVEN_LAUNCHED = bay([
  deployment('d1', 'atlas-1', 'completed'),
  deployment('d2', 'raven-1', 'walking-to')
])

let emit: (state: AppState) => void

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  Object.assign(window, {
    mechbay: {
      getState: vi.fn().mockResolvedValue(AT_START),
      onStateChange: (listener: (state: AppState) => void) => {
        emit = listener
        return () => {}
      }
    }
  })
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

async function mount(ui: React.JSX.Element): Promise<HTMLElement> {
  const { container } = render(ui)
  await act(async () => {}) // the initial getState resolves
  return container
}

function step(state: AppState): void {
  act(() => emit(state))
}

describe('HUD callouts', () => {
  const holding = (c: HTMLElement): boolean => /RAVEN-PRIME HOLDING/.test(c.textContent ?? '')

  it('announces HOLDING after the line ahead while the mission still waits', async () => {
    const hud = await mount(<CockpitHud />)
    step(AT_START)
    step(RAVEN_WAITS)
    act(() => vi.advanceTimersByTime(3_000))
    expect(holding(hud)).toBe(true)
  })

  it('drops a HOLDING line still waiting its turn once the mission launches', async () => {
    const hud = await mount(<CockpitHud />)
    step(AT_START)
    step(RAVEN_WAITS)
    act(() => vi.advanceTimersByTime(500))
    step(RAVEN_LAUNCHED)
    for (let t = 0; t < 12; t++) {
      act(() => vi.advanceTimersByTime(1_000))
      expect(holding(hud)).toBe(false)
    }
  })
})

describe('radio feed', () => {
  const holding = (c: HTMLElement): boolean => /HOLDING/.test(c.textContent ?? '')

  it('reveals the holding call after the one ahead while the mission still waits', async () => {
    const feed = await mount(<CommsFeed />)
    step(AT_START)
    step(RAVEN_WAITS)
    expect(holding(feed)).toBe(false)
    act(() => vi.advanceTimersByTime(1_000))
    expect(holding(feed)).toBe(true)
  })

  it('drops a holding call not yet on screen once the mission launches, even when the reveal timer runs late', async () => {
    const feed = await mount(<CommsFeed />)
    step(AT_START)
    step(RAVEN_WAITS)
    // The holding call was due 900 ms in, but the feed's timer has not fired
    // yet (a busy renderer): the clock moves on without it.
    vi.setSystemTime(100_000 + 950)
    step(RAVEN_LAUNCHED)
    for (let t = 0; t < 8; t++) {
      act(() => vi.advanceTimersByTime(1_000))
      expect(holding(feed)).toBe(false)
    }
  })

  it('drops a holding call whose reveal and the launch land in the same render', async () => {
    const feed = await mount(<CommsFeed />)
    step(AT_START)
    step(RAVEN_WAITS)
    // The reveal timer fires and the launch arrives before React renders:
    // both updates are batched, so the holding call was never on screen.
    act(() => {
      vi.advanceTimersByTime(950)
      emit(RAVEN_LAUNCHED)
    })
    expect(holding(feed)).toBe(false)
    for (let t = 0; t < 8; t++) {
      act(() => vi.advanceTimersByTime(1_000))
      expect(holding(feed)).toBe(false)
    }
  })
})
