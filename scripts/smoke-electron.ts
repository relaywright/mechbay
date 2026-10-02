/**
 * Launch the built app (run `npm run build` first) in an isolated profile and
 * check that it boots cleanly: no renderer errors, the preload bridge works
 * under the sandbox, and the scene hook is exposed only in demo mode.
 *
 *   node --experimental-strip-types scripts/smoke-electron.ts [--demo] [--scale=2] [--size=1920x1080] [--shot=out.png] [--profile=<dir>]
 *
 * --scale=2 with --size=1920x1080 reproduces a maximized 4K window.
 * [--profile=<dir>]  use and keep an existing profile folder (default: a throwaway one)
 */
import { _electron, type ElectronApplication } from 'playwright-core'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import assert from 'node:assert/strict'
import type { MechBayApi } from '../src/preload/index'

// No tsconfig covers scripts/, so mirror src/preload/index.d.ts here for the
// page.evaluate callbacks below.
declare global {
  interface Window {
    mechbay: MechBayApi
  }
}

const root = resolve(import.meta.dirname, '..')
const args = process.argv.slice(2)
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

const demo = args.includes('--demo')
const scale = Number(option('scale') ?? '1')
const [width, height] = (option('size') ?? '1600x1000').split('x').map(Number)
const shot = option('shot')
const keepProfile = option('profile')

/** True when `path` is `dir` or inside it. Windows and macOS paths compare case-insensitively. */
function isInside(path: string, dir: string): boolean {
  const caseless = process.platform === 'win32' || process.platform === 'darwin'
  const normalize = (p: string): string => (caseless ? resolve(p).toLowerCase() : resolve(p))
  const target = normalize(path)
  const base = normalize(dir)
  return target === base || target.startsWith(base + sep)
}

/** Where the installed MechBay keeps its saved bay. The smoke run must never use it. */
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
    `--profile must not be the installed app's profile (${realProfileDir()})`
  )
}

// Checked before creating the folder, and again once links are resolved: a
// junction or symlink could otherwise point a harmless-looking path at the
// real profile.
if (keepProfile) {
  assertNotRealProfile(keepProfile)
  mkdirSync(resolve(keepProfile), { recursive: true })
}
// Canonical path (no 8.3 short names or symlinks), so the main process can
// compare it exactly against app.getPath('userData').
const profile = realpathSync.native(
  keepProfile ? resolve(keepProfile) : mkdtempSync(join(tmpdir(), 'mechbay-smoke-'))
)
if (keepProfile) assertNotRealProfile(profile)
const env: Record<string, string> = {}
for (const [key, value] of Object.entries(process.env)) {
  if (value !== undefined && key !== 'ELECTRON_RUN_AS_NODE' && key !== 'MECHBAY_DEMO') {
    env[key] = value
  }
}
if (demo) env.MECHBAY_DEMO = '1'
// src/main/index.ts exits at startup unless userData is exactly this profile.
env.MECHBAY_REQUIRE_USER_DATA = profile

let app: ElectronApplication | undefined
const errors: string[] = []
try {
  app = await _electron.launch({
    args: [
      '.',
      ...(demo ? ['--demo'] : []),
      `--user-data-dir=${profile}`,
      `--force-device-scale-factor=${scale}`
    ],
    cwd: root,
    env,
    // Playwright adds --no-sandbox on Linux unless asked not to.
    chromiumSandbox: true
  })
  // Second layer behind the main-process guard: report where userData landed.
  const userData = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.ok(isInside(userData, profile), `userData ${userData} must be inside ${profile}`)

  // Wait for the window before resizing it: launch() can return first.
  const page = await app.firstWindow()
  await app.evaluate(
    ({ BrowserWindow }, [w, h]) => BrowserWindow.getAllWindows()[0].setContentSize(w, h),
    [width, height]
  )
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })

  await page.waitForFunction(() => typeof window.mechbay?.getAppMode === 'function')
  const mode = await page.evaluate(() => window.mechbay.getAppMode())
  assert.equal(mode.demo, demo, 'app mode must match the launch flag')
  const health = await page.evaluate(() => window.mechbay.getStateHealth())

  await page.locator('.command-header').waitFor()
  await page.waitForTimeout(3500)
  await page.evaluate(() => document.fonts.ready)

  const sceneExposed = await page.evaluate(() => '__mechbayScene' in window)
  assert.equal(sceneExposed, demo, 'the scene hook must exist only in demo mode')
  assert.equal(
    await page.evaluate(() => 'electron' in window),
    false,
    'window.electron must be gone'
  )

  // Ask the OS-level process metrics, not the webPreferences we asked for: a
  // renderer that silently fell back to no sandbox reports false here.
  // (`sandboxed` is reported on Windows and macOS; elsewhere this is null.)
  const sandboxed = await app.evaluate(({ app, BrowserWindow }) => {
    const pid = BrowserWindow.getAllWindows()[0].webContents.getOSProcessId()
    return app.getAppMetrics().find((metric) => metric.pid === pid)?.sandboxed ?? null
  })
  if (shot) await page.screenshot({ path: resolve(shot) })
  console.log(
    JSON.stringify({
      demo,
      scale,
      size: [width, height],
      sandboxed,
      userData,
      health: health.ok ? 'ok' : health.reason
    })
  )
  // Linux does not report `sandboxed`, so null there means unknown, not off.
  assert.equal(sandboxed, process.platform === 'linux' ? null : true, 'renderer sandbox')
  assert.deepEqual(errors, [], 'renderer errors')
} finally {
  // Clean up even if launch fails or close hangs: give a graceful close 15s,
  // then kill the whole Electron process tree. Windows may hold files briefly.
  try {
    if (app) {
      const child = app.process()
      const closed = await Promise.race([
        app.close().then(
          () => true,
          (error: unknown) => {
            console.error('[smoke] close failed:', error)
            return false
          }
        ),
        new Promise<false>((done) => setTimeout(() => done(false), 15_000).unref())
      ])
      if (!closed && child.exitCode === null && child.pid !== undefined) {
        console.error('[smoke] close did not finish; killing the Electron process tree')
        if (process.platform === 'win32') {
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { timeout: 10_000 })
        } else {
          child.kill('SIGKILL')
        }
      }
    }
  } finally {
    if (!keepProfile)
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
