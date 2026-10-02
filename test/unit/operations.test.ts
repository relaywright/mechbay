import { describe, expect, it } from 'vitest'
import {
  canDispatch,
  currentMission,
  fleetTelemetry,
  isActiveMission,
  missionDuration,
  noun
} from '../../src/renderer/src/operations'
import type { AppState, Companion, Deployment, DeploymentStatus } from '../../src/shared/types'

const companion = { id: 'atlas', cliAvailable: true } as Companion
const mission = (status: DeploymentStatus, overrides: Partial<Deployment> = {}): Deployment => ({
  id: 'mission',
  companionId: 'atlas',
  facilityId: 'reactor',
  taskPrompt: 'Inspect telemetry',
  startedAt: 1000,
  status,
  ...overrides
})

describe('fleet operations', () => {
  it.each(['walking-to', 'working', 'awaiting-input', 'returning'] as const)(
    'counts %s as active and prevents double dispatch',
    (status) => {
      expect(isActiveMission(mission(status))).toBe(true)
      expect(canDispatch(companion, [mission(status)])).toBe(false)
    }
  )
  it('reserves a queued mech without consuming an active slot', () => {
    expect(isActiveMission(mission('queued'))).toBe(false)
    expect(canDispatch(companion, [mission('queued')])).toBe(false)
  })
  it('does not mistake historical or other-mech deployments for an assignment', () => {
    const deployments = [mission('completed'), mission('working', { companionId: 'raven' })]
    expect(currentMission('atlas', deployments)).toBeUndefined()
    expect(canDispatch(companion, deployments)).toBe(true)
    expect(canDispatch({ ...companion, cliAvailable: false }, deployments)).toBe(false)
  })
  it('reports actual linked facilities and completed missions, excluding failed and cancelled runs', () => {
    const state = {
      companions: [
        companion,
        { id: 'raven', cliAvailable: true },
        { id: 'locust', cliAvailable: false }
      ],
      deployments: [
        mission('working'),
        mission('completed'),
        mission('failed'),
        mission('cancelled')
      ],
      facilities: [{ path: 'C:/project' }, { path: '' }]
    } as AppState
    expect(fleetTelemetry(state)).toEqual({
      ready: 1,
      active: 1,
      queued: 0,
      completed: 1,
      linked: 1
    })
  })
  it('freezes completed durations and clamps clock skew', () => {
    expect(missionDuration(mission('working'), 66000)).toBe('01:05')
    expect(missionDuration(mission('completed', { completedAt: 3000 }), 1000000)).toBe('00:02')
    expect(missionDuration(mission('working'), 0)).toBe('00:00')
  })
})

describe('noun', () => {
  it('uses the singular only for exactly one', () => {
    expect(noun(1, 'PROJECT')).toBe('PROJECT')
    expect(noun(0, 'PROJECT')).toBe('PROJECTS')
    expect(noun(2, 'MISSION')).toBe('MISSIONS')
    expect(noun(1, 'file')).toBe('file')
    expect(noun(3, 'file')).toBe('files')
    expect(noun(2, 'facility', 'facilities')).toBe('facilities')
  })
})
