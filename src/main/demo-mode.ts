import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { ulid } from '../shared/ulid'
import type { Facility } from '../shared/types'
import type { StateManager } from './state-manager'

const GRID_WIDTH = 16
const GRID_HEIGHT = 16

export function isDemoMode(
  env: NodeJS.ProcessEnv = process.env,
  argv: string[] = process.argv
): boolean {
  return env.MECHBAY_DEMO === '1' || argv.includes('--demo')
}

export function seedDemoWorkspace(dir: string): void {
  if (existsSync(join(dir, '.git'))) return

  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(
    join(dir, 'README.md'),
    '# Reactor Control\n\nA compact control surface for monitoring a frontier fusion reactor.\n',
    'utf8'
  )
  writeFileSync(
    join(dir, 'src', 'reactor-control.ts'),
    `export type ReactorState = 'offline' | 'warming' | 'stable' | 'critical'

export interface ReactorReading {
  coreTemperature: number
  coolantPressure: number
  outputMegawatts: number
}

const SAFE_TEMPERATURE = 920
const MIN_COOLANT_PRESSURE = 42

export function classifyReactor(reading: ReactorReading): ReactorState {
  if (reading.coreTemperature <= 0 && reading.outputMegawatts <= 0) {
    return 'offline'
  }

  if (
    reading.coreTemperature > SAFE_TEMPERATURE ||
    reading.coolantPressure < MIN_COOLANT_PRESSURE
  ) {
    return 'critical'
  }

  if (reading.outputMegawatts < 250) {
    return 'warming'
  }

  return 'stable'
}

export function reactorSummary(reading: ReactorReading): string {
  const state = classifyReactor(reading)
  return \`REACTOR \${state.toUpperCase()} // \${reading.outputMegawatts} MW\`
}
`,
    'utf8'
  )
  writeFileSync(
    join(dir, 'src', 'telemetry.ts'),
    `import type { ReactorReading } from './reactor-control'

export interface TelemetryPacket {
  recordedAt: string
  reading: ReactorReading
}

export function encodeTelemetry(reading: ReactorReading): string {
  const packet: TelemetryPacket = {
    recordedAt: new Date().toISOString(),
    reading
  }

  return JSON.stringify(packet)
}
`,
    'utf8'
  )
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'reactor-control',
        version: '0.1.0',
        private: true,
        type: 'module',
        scripts: { check: 'tsc --noEmit' }
      },
      null,
      2
    ) + '\n',
    'utf8'
  )

  try {
    execFileSync('git', ['init'], { cwd: dir, stdio: 'ignore' })
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'ignore' })
    execFileSync(
      'git',
      [
        '-c',
        'user.email=demo@mechbay.local',
        '-c',
        'user.name=MechBay Demo',
        // The player's global signing or hooks must not block the baseline
        // commit; without it the debrief counts every seeded file as changed.
        '-c',
        'commit.gpgsign=false',
        '-c',
        `core.hooksPath=${join(dir, '.git', 'mechbay-no-hooks')}`,
        'commit',
        '-m',
        'initial survey'
      ],
      { cwd: dir, stdio: 'ignore' }
    )
  } catch (error) {
    console.warn('[demo] Could not initialize demo workspace git history:', error)
  }
}

function findFreeTile(facilities: Facility[]): { x: number; y: number } {
  const occupied = new Set(facilities.map((facility) => `${facility.tile.x},${facility.tile.y}`))
  for (let y = 0; y < GRID_HEIGHT; y += 1) {
    for (let x = 0; x < GRID_WIDTH; x += 1) {
      if (!occupied.has(`${x},${y}`)) return { x, y }
    }
  }
  return { x: 0, y: 0 }
}

export function linkDemoFacility(state: StateManager, demoDir: string): void {
  const current = state.getState()
  if (current.facilities.some((facility) => facility.path === demoDir)) return

  const preferred = current.facilities.find(
    (facility) => facility.path === '' && facility.name === 'Research Lab'
  )
  const unlinked = preferred ?? current.facilities.find((facility) => facility.path === '')

  if (unlinked) {
    state.updateState((previous) => ({
      ...previous,
      facilities: previous.facilities.map((facility) =>
        facility.id === unlinked.id ? { ...facility, path: demoDir } : facility
      )
    }))
    return
  }

  const demoFacility: Facility = {
    id: ulid(),
    facilityType: 'research-lab',
    name: 'Demo Reactor',
    tile: findFreeTile(current.facilities),
    path: demoDir,
    source: 'manual',
    discoveredAt: Date.now()
  }
  state.updateState((previous) => ({
    ...previous,
    facilities: [...previous.facilities, demoFacility]
  }))
}
