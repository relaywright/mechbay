import { execFileSync } from 'child_process'
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync
} from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDemoMode, linkDemoFacility, seedDemoWorkspace } from '../../src/main/demo-mode'
import { StateManager, type StoreLike } from '../../src/main/state-manager'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mechbay-demo-mode-'))
  tempDirs.push(dir)
  return dir
}

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (key) => data[key],
    set: (key, value) => {
      data[key] = value
    },
    has: (key) => key in data
  }
}

afterEach(() => {
  vi.unstubAllEnvs()
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('isDemoMode', () => {
  it.each([
    [{ MECHBAY_DEMO: '1' }, ['electron'], true],
    [{}, ['electron', '--demo'], true],
    [{ MECHBAY_DEMO: '0' }, ['electron'], false],
    [{ MECHBAY_DEMO: 'true' }, ['electron'], false]
  ])('checks the environment and argv', (env, argv, expected) => {
    expect(isDemoMode(env, argv)).toBe(expected)
  })
})

describe('seedDemoWorkspace', () => {
  it('creates a plausible git-backed workspace and is idempotent', () => {
    const root = makeTempDir()
    const workspace = join(root, 'facility')

    seedDemoWorkspace(workspace)
    const firstReadme = readFileSync(join(workspace, 'README.md'), 'utf8')
    expect(firstReadme).toContain('Reactor Control')
    expect(existsSync(join(workspace, 'src', 'reactor-control.ts'))).toBe(true)
    expect(existsSync(join(workspace, 'src', 'telemetry.ts'))).toBe(true)
    expect(existsSync(join(workspace, 'package.json'))).toBe(true)
    expect(existsSync(join(workspace, '.git'))).toBe(true)

    expect(() => seedDemoWorkspace(workspace)).not.toThrow()
    expect(readFileSync(join(workspace, 'README.md'), 'utf8')).toBe(firstReadme)
  })

  it("commits the starting point even when the player's global git config signs commits or runs hooks", () => {
    const root = makeTempDir()
    const hooks = join(root, 'global-hooks')
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n')
    chmodSync(join(hooks, 'pre-commit'), 0o755)
    const globalConfig = join(root, 'global.gitconfig')
    writeFileSync(
      globalConfig,
      [
        '[commit]',
        '\tgpgsign = true',
        '[gpg]',
        '\tprogram = mechbay-missing-gpg',
        '[core]',
        `\thooksPath = ${hooks.split('\\').join('/')}`,
        ''
      ].join('\n')
    )
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    const workspace = join(root, 'facility')

    seedDemoWorkspace(workspace)

    // Without a baseline commit the debrief would count every seeded file as changed.
    const head = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: workspace, encoding: 'utf8' })
    expect(head.trim()).toMatch(/^[0-9a-f]{40}$/)
  })
})

describe('linkDemoFacility', () => {
  it('links the preferred unlinked facility and is idempotent', () => {
    const state = new StateManager(makeInMemoryStore(), makeTempDir())
    const demoDir = join(makeTempDir(), 'demo-facility')

    linkDemoFacility(state, demoDir)
    linkDemoFacility(state, demoDir)

    const linked = state.getState().facilities.filter((facility) => facility.path === demoDir)
    expect(linked).toHaveLength(1)
    expect(linked[0].name).toBe('Research Lab')
  })

  it('adds a new facility on a free tile when none are unlinked', () => {
    const state = new StateManager(makeInMemoryStore(), makeTempDir())
    state.updateState((current) => ({
      ...current,
      facilities: current.facilities.map((facility) => ({
        ...facility,
        path: `C:/linked/${facility.id}`
      }))
    }))
    const before = state.getState().facilities
    const occupied = new Set(before.map((facility) => `${facility.tile.x},${facility.tile.y}`))
    const demoDir = join(makeTempDir(), 'demo-facility')

    linkDemoFacility(state, demoDir)

    const added = state.getState().facilities.find((facility) => facility.path === demoDir)
    expect(state.getState().facilities).toHaveLength(before.length + 1)
    expect(added).toMatchObject({
      facilityType: 'research-lab',
      name: 'Demo Reactor',
      source: 'manual'
    })
    expect(occupied.has(`${added?.tile.x},${added?.tile.y}`)).toBe(false)
  })
})
