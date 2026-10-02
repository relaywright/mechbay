import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'
import {
  CURRENT_SCHEMA_VERSION,
  migrateState,
  migrateV2ToV3,
  type AppStateV2
} from '../../src/main/state-migrations'

const FIXTURE = path.join(__dirname, '../fixtures/state/v2-mechbay-1.4.0.json')
const loadV2 = (): AppStateV2 =>
  (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { state: AppStateV2 }).state

describe('migrateState', () => {
  it('upgrades the v1.4.0 save to the current schema', () => {
    const outcome = migrateState(loadV2())
    expect(outcome.kind).toBe('migrated')
    if (outcome.kind !== 'migrated') return
    expect(outcome.from).toBe(2)
    expect(outcome.state.version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('keeps every facility, deployment and companion detail the user created', () => {
    const before = loadV2()
    const outcome = migrateState(before)
    if (outcome.kind !== 'migrated') throw new Error(outcome.kind)
    const after = outcome.state
    expect(
      after.facilities.map(({ id, name, path, tile, facilityType, source }) => ({
        id,
        name,
        path,
        tile,
        facilityType,
        source
      }))
    ).toEqual(
      before.facilities.map(({ id, name, path, tile, facilityType, source }) => ({
        id,
        name,
        path,
        tile,
        facilityType,
        source
      }))
    )
    expect(
      after.deployments.map(
        ({ id, status, summary, diffStats, diffFiles, exitCode, startedAt, completedAt }) => ({
          id,
          status,
          summary,
          diffStats,
          diffFiles,
          exitCode,
          startedAt,
          completedAt
        })
      )
    ).toEqual(
      before.deployments.map(
        ({ id, status, summary, diffStats, diffFiles, exitCode, startedAt, completedAt }) => ({
          id,
          status,
          summary,
          diffStats,
          diffFiles,
          exitCode,
          startedAt,
          completedAt
        })
      )
    )
    expect(
      after.companions.map(({ id, name, runtime, model, soulPath, memoryPath, homeTile }) => ({
        id,
        name,
        runtime,
        model,
        soulPath,
        memoryPath,
        homeTile
      }))
    ).toEqual(
      before.companions.map(({ id, name, runtime, model, soulPath, memoryPath, homeTile }) => ({
        id,
        name,
        runtime,
        model,
        soulPath,
        memoryPath,
        homeTile
      }))
    )
    expect(after.settings).toMatchObject({
      projectsDir: before.settings.projectsDir,
      concurrencyCap: 3,
      reduceMotion: true,
      crtOverlay: false
    })
  })

  it('drops the five fields no player sees or edits', () => {
    const outcome = migrateState(loadV2())
    if (outcome.kind !== 'migrated') throw new Error(outcome.kind)
    const state = outcome.state as unknown as Record<string, unknown> & {
      settings: Record<string, unknown>
    }
    expect('lastScanAt' in state).toBe(false)
    expect('companionNameOverrides' in state.settings).toBe(false)
    for (const companion of outcome.state.companions)
      expect('recentDeploymentIds' in companion).toBe(false)
  })

  it('never mutates its input', () => {
    const input = loadV2()
    const copy = structuredClone(input)
    migrateState(input)
    expect(input).toEqual(copy)
  })

  it('refuses a save from a newer MechBay', () => {
    expect(migrateState({ ...loadV2(), version: 99 })).toEqual({ kind: 'newer', found: 99 })
  })

  it.each([
    ['no version', { companions: [] }],
    ['null', null],
    ['a string', 'not a bay'],
    [
      'pre-release schema 1',
      { version: 1, companions: [], facilities: [], deployments: [], logChunks: [], settings: {} }
    ],
    ['schema 2 missing its arrays', { version: 2 }],
    ['current schema missing its arrays', { version: CURRENT_SCHEMA_VERSION }]
  ])('calls %s unreadable', (_label, raw) => {
    expect(migrateState(raw).kind).toBe('unreadable')
  })

  it('reports a migration that throws as failed, not unreadable', () => {
    const outcome = migrateState(loadV2(), {
      2: () => {
        throw new Error('boom')
      }
    })
    expect(outcome).toEqual({ kind: 'failed', from: 2, error: 'boom' })
  })

  it('reports a missing migration step as failed', () => {
    expect(migrateState(loadV2(), {}).kind).toBe('failed')
  })

  it('passes a current save through untouched', () => {
    const current = migrateV2ToV3(loadV2())
    expect(migrateState(current)).toEqual({ kind: 'current', state: current })
  })
})
