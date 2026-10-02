/**
 * Launch the built app (run `npm run build` first) in an isolated profile.
 * Shared by scripts/smoke-electron.ts and scripts/verify-missions.ts so both
 * use the same guards: the installed app's profile is never touched, and the
 * main process refuses to start unless userData is exactly the given profile.
 */
import { _electron, type ElectronApplication, type Page } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import type { MechBayApi } from '../../src/preload/index'

// No tsconfig covers scripts/, so mirror src/preload/index.d.ts here for the
// page.evaluate callbacks in the scripts that use this helper.
declare global {
  interface Window {
    mechbay: MechBayApi
  }
}

const root = resolve(import.meta.dirname, '..', '..')

/** True when `path` is `dir` or inside it. Windows and macOS paths compare case-insensitively. */
export function isInside(path: string, dir: string): boolean {
  const caseless = process.platform === 'win32' || process.platform === 'darwin'
  const normalize = (p: string): string => (caseless ? resolve(p).toLowerCase() : resolve(p))
  const target = normalize(path)
  const base = normalize(dir)
  return target === base || target.startsWith(base + sep)
}

/** Where the installed MechBay keeps its saved bay. Scripts must never use it. */
function realProfileDir(): string {
  if (process.platform === 'win32') {
    return join(process.env.APPDATA ?? join(homedir(), 'AppData', 'Roaming'), 'mechbay')
  }
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', 'mechbay')
  return join(process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'mechbay')
}

/** The path with links and 8.3 short names resolved, or as given if it doesn't exist yet. */
function canonical(path: string): string {
  try {
    return realpathSync.native(resolve(path))
  } catch {
    return resolve(path)
  }
}

function assertNotRealProfile(dir: string): void {
  const real = canonical(realProfileDir())
  const target = canonical(dir)
  assert.ok(
    !isInside(target, real) && !isInside(real, target),
    `the profile must not be the installed app's profile (${realProfileDir()})`
  )
}

/**
 * The profile folder to launch with: `keep` (created if missing) or a fresh
 * throwaway one under the system temp folder. Returned canonical (no 8.3
 * short names or symlinks), so the main process can compare it exactly
 * against app.getPath('userData').
 */
export function prepareProfile(keep?: string): string {
  // Checked before creating the folder, and again once links are resolved: a
  // junction or symlink could otherwise point a harmless-looking path at the
  // real profile.
  if (keep) {
    assertNotRealProfile(keep)
    mkdirSync(resolve(keep), { recursive: true })
  }
  const profile = realpathSync.native(
    keep ? resolve(keep) : mkdtempSync(join(tmpdir(), 'mechbay-smoke-'))
  )
  assertNotRealProfile(profile)
  return profile
}

export interface LaunchOptions {
  demo: boolean
  /** From prepareProfile(). */
  profile: string
  /** Device scale factor (2 with 1920x1080 reproduces a maximized 4K window). */
  scale?: number
  /** Window content size as `<width>x<height>`. */
  size?: string
}

export interface LaunchedMechbay {
  app: ElectronApplication
  page: Page
  userData: string
  /** Renderer errors (uncaught exceptions and console.error), collected from launch on. */
  errors: string[]
}

/** Launch, wait for the bridge and the command header, and collect renderer errors. */
export async function launchMechbay(opts: LaunchOptions): Promise<LaunchedMechbay> {
  const { demo, profile } = opts
  const [width, height] = (opts.size ?? '1600x1000').split('x').map(Number)
  assertNotRealProfile(profile)

  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'MECHBAY_DEMO') {
      env[key] = value
    }
  }
  if (demo) env.MECHBAY_DEMO = '1'
  // src/main/index.ts exits at startup unless userData is exactly this profile.
  env.MECHBAY_REQUIRE_USER_DATA = profile

  const app = await _electron.launch({
    args: [
      '.',
      ...(demo ? ['--demo'] : []),
      `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${opts.scale ?? 1}`
    ],
    cwd: root,
    env,
    // Playwright adds --no-sandbox on Linux unless asked not to.
    chromiumSandbox: true
  })
  try {
    // Wait for the window before asking the main process anything: launch()
    // can return first, and on a slow start (a large upgraded save) an
    // evaluate sent that early can be dropped ("Resulting promise was
    // garbage collected").
    const page = await app.firstWindow()
    // Second layer behind the main-process guard: report where userData landed.
    const userData = await app.evaluate(({ app }) => app.getPath('userData'))
    assert.ok(isInside(userData, profile), `userData ${userData} must be inside ${profile}`)

    await app.evaluate(
      ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
      [width, height]
    )
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('console', (message) => {
      if (message.type() === 'error') errors.push(message.text())
    })

    await page.waitForFunction(() => typeof window.mechbay?.getAppMode === 'function')
    await page.locator('.command-header').waitFor()
    return { app, page, userData, errors }
  } catch (error) {
    await closeMechbay(app)
    throw error
  }
}

/**
 * Close the app even if close hangs: give a graceful close 15s, then kill the
 * whole Electron process tree (by its own PID only). Never rejects.
 */
export async function closeMechbay(app: ElectronApplication | undefined): Promise<void> {
  if (!app) return
  const child = app.process()
  const closed = await Promise.race([
    app.close().then(
      () => true,
      (error: unknown) => {
        console.error('[launch] close failed:', error)
        return false
      }
    ),
    new Promise<false>((done) => setTimeout(() => done(false), 15_000).unref())
  ])
  if (!closed && child.exitCode === null && child.pid !== undefined) {
    console.error('[launch] close did not finish; killing the Electron process tree')
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000 })
    } else {
      child.kill('SIGKILL')
    }
  }
}
