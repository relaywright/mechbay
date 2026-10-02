import { copyFileSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { StateManager } from '../../src/main/state-manager'
import { CURRENT_SCHEMA_VERSION, type AppStateV2 } from '../../src/main/state-migrations'
import { computeServiceRecord } from '../../src/renderer/src/service-record'
import type { Deployment } from '../../src/shared/types'
import { JsonFileStore } from '../helpers/json-file-store'

const FIXTURE = path.join(__dirname, '../fixtures/state/v2-mechbay-1.4.0.json')

describe('migration guard (Phase 0 Track B done criterion, S7)', () => {
  let dir: string
  let file: string
  let original: Buffer
  const fixtureState = (): AppStateV2 =>
    (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { state: AppStateV2 }).state
  const backups = (label: string): string[] =>
    readdirSync(dir).filter((name) => name.startsWith(`mechbay-state.${label}-backup-`))

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mechbay-migrate-'))
    file = path.join(dir, 'mechbay-state.json')
    copyFileSync(FIXTURE, file)
    original = readFileSync(file)
  })
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('loads a v1.4.0 save after the schema bump with facilities, deployments and service records intact', () => {
    const before = fixtureState()
    const manager = new StateManager(new JsonFileStore(file), dir)
    const after = manager.getState()

    expect(after.version).toBe(CURRENT_SCHEMA_VERSION)
    expect(after.facilities.map((f) => [f.id, f.name, f.path])).toEqual(
      before.facilities.map((f) => [f.id, f.name, f.path])
    )
    expect(after.deployments.map((d) => [d.id, d.status, d.summary])).toEqual(
      before.deployments.map((d) => [d.id, d.status, d.summary])
    )
    for (const companion of before.companions) {
      expect(computeServiceRecord(companion.id, after.deployments)).toEqual(
        computeServiceRecord(companion.id, before.deployments as unknown as Deployment[])
      )
    }
    expect(manager.getHealth()).toEqual({ ok: true })
    const saved = JSON.parse(readFileSync(file, 'utf8')) as { state: { version: number } }
    expect(saved.state.version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('writes a byte-identical backup of the old file before upgrading', () => {
    new StateManager(new JsonFileStore(file), dir)
    const found = backups('v2')
    expect(found).toHaveLength(1)
    expect(readFileSync(path.join(dir, found[0])).equals(original)).toBe(true)
  })

  it('leaves the original byte-identical when a migration fails, even after the app changes state', () => {
    const manager = new StateManager(new JsonFileStore(file), dir, {
      migrations: {
        2: () => {
          throw new Error('deliberate failure')
        }
      }
    })
    manager.updateState((s) => ({ ...s, settings: { ...s.settings, reduceMotion: false } }))
    expect(readFileSync(file).equals(original)).toBe(true)
    expect(manager.getHealth()).toMatchObject({
      ok: false,
      reason: 'migration-failed',
      statePath: file
    })
  })

  it('refuses a newer-version save without overwriting it', () => {
    writeFileSync(
      file,
      JSON.stringify({ state: { ...fixtureState(), version: 99 } }, undefined, '\t')
    )
    const newer = readFileSync(file)
    const manager = new StateManager(new JsonFileStore(file), dir)
    manager.updateState((s) => ({ ...s, settings: { ...s.settings, concurrencyCap: 5 } }))
    expect(readFileSync(file).equals(newer)).toBe(true)
    expect(manager.getHealth()).toMatchObject({ ok: false, reason: 'newer-version' })
    expect(manager.getState().version).toBe(CURRENT_SCHEMA_VERSION)
  })

  it('keeps a copy of an unreadable save and starts a fresh bay with a notice', () => {
    const v1 = {
      state: {
        version: 1,
        companions: [],
        facilities: [],
        deployments: [],
        logChunks: [],
        settings: {}
      }
    }
    writeFileSync(file, JSON.stringify(v1, undefined, '\t'))
    const before = readFileSync(file)
    const manager = new StateManager(new JsonFileStore(file), dir)
    const found = backups('unreadable')
    expect(found).toHaveLength(1)
    expect(readFileSync(path.join(dir, found[0])).equals(before)).toBe(true)
    expect(manager.getState().companions).toHaveLength(5)
    expect(manager.getHealth()).toMatchObject({
      ok: true,
      notice: expect.stringContaining('started a fresh one')
    })
  })

  it('never writes when the saved file cannot be read', () => {
    const locked = new JsonFileStore(file)
    locked.get = () => {
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
    }
    const manager = new StateManager(locked, dir)
    manager.updateState((s) => ({ ...s }))
    expect(readFileSync(file).equals(original)).toBe(true)
    expect(manager.getHealth()).toMatchObject({ ok: false, reason: 'read-failed' })
  })

  it('does not upgrade when it cannot make the backup', () => {
    const manager = new StateManager(new JsonFileStore(file), dir, {
      copyFile: () => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      }
    })
    expect(readFileSync(file).equals(original)).toBe(true)
    expect(manager.getHealth()).toMatchObject({
      ok: false,
      reason: 'migration-failed',
      message: expect.stringContaining('ENOSPC')
    })
  })
})
