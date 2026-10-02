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
import type { ElectronApplication } from 'playwright-core'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import { closeMechbay, launchMechbay, prepareProfile } from './lib/launch-mechbay.ts'

const args = process.argv.slice(2)
const option = (name: string): string | undefined =>
  args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3)

const demo = args.includes('--demo')
const scale = Number(option('scale') ?? '1')
const size = option('size') ?? '1600x1000'
const shot = option('shot')
const keepProfile = option('profile')
const profile = prepareProfile(keepProfile)

let app: ElectronApplication | undefined
try {
  const launched = await launchMechbay({ demo, profile, scale, size })
  app = launched.app
  const { page, userData, errors } = launched

  const mode = await page.evaluate(() => window.mechbay.getAppMode())
  assert.equal(mode.demo, demo, 'app mode must match the launch flag')
  const health = await page.evaluate(() => window.mechbay.getStateHealth())

  await page.waitForTimeout(3500)
  await page.evaluate(() => document.fonts.ready)

  // Each crew card's status and stat line share one row; they must never touch.
  const crewOverlaps = await page.evaluate(() =>
    [...document.querySelectorAll('.crew-card')].flatMap((card) => {
      const status = card.querySelector('.crew-status')?.getBoundingClientRect()
      const stat = card.querySelector('.crew-stat-line')?.getBoundingClientRect()
      if (!status || !stat || stat.width === 0 || status.right <= stat.left) return []
      return [card.querySelector('.crew-name')?.textContent ?? '?']
    })
  )
  assert.deepEqual(crewOverlaps, [], 'crew card status runs into its stat line')

  // A deployed mech's card adds a DEPLOYED tag to its header row; where the
  // portrait would cover it, the tag must be hidden. Add one to every card
  // to check, then take it away again.
  const tagsUnderPortrait = await page.evaluate(() =>
    [...document.querySelectorAll('.crew-card')].flatMap((card) => {
      const tag = document.createElement('b')
      tag.className = 'crew-deployed-tag'
      tag.textContent = 'DEPLOYED'
      card.querySelector('.crew-number')?.appendChild(tag)
      const box = tag.getBoundingClientRect()
      const portrait = card.querySelector('.crew-portrait')?.getBoundingClientRect()
      tag.remove()
      if (!portrait || box.width === 0 || box.right <= portrait.left) return []
      return [card.querySelector('.crew-name')?.textContent ?? '?']
    })
  )
  assert.deepEqual(tagsUnderPortrait, [], 'a crew card DEPLOYED tag runs under the portrait')

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
      size: size.split('x').map(Number),
      sandboxed,
      userData,
      health: health.ok ? 'ok' : health.reason
    })
  )
  // Linux does not report `sandboxed`, so null there means unknown, not off.
  assert.equal(sandboxed, process.platform === 'linux' ? null : true, 'renderer sandbox')
  assert.deepEqual(errors, [], 'renderer errors')
} finally {
  // Clean up even if launch fails or close hangs. Windows may hold files briefly.
  try {
    await closeMechbay(app)
  } finally {
    if (!keepProfile)
      rmSync(profile, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
}
