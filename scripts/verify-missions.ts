/**
 * Drive the built app (run `npm run build` first) through real missions in a
 * throwaway profile, and save screenshots as evidence.
 *
 *   node --experimental-strip-types scripts/verify-missions.ts --demo | --real  [--out=<dir>]
 *
 * --demo: send 4 simulated missions with 3 slots, screenshot the line, cancel
 *         the waiting one, recall a running one, and open Settings for the
 *         Autonomy control.
 * --real: link a throwaway git repo, send the Claude mech on a one-line edit,
 *         time its first readable line, and open its debrief.
 */
import type { ElectronApplication, Page } from 'playwright-core'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'
import type { Deployment } from '../src/shared/types'
import { closeMechbay, launchMechbay, prepareProfile } from './lib/launch-mechbay.ts'

const option = (name: string): string | undefined =>
  process.argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3)
const demo = process.argv.includes('--demo')
assert.ok(demo || process.argv.includes('--real'), 'pass --demo or --real')
const out = resolve(option('out') ?? 'artifacts/verify-missions')
mkdirSync(out, { recursive: true })
const profile = prepareProfile()
const ENDED = ['completed', 'failed', 'cancelled']

/** Let the boot animation finish and the fonts load, as the other capture scripts do. */
async function settle(page: Page): Promise<void> {
  await page.waitForTimeout(3500)
  await page.evaluate(() => document.fonts.ready)
}

/**
 * Poll saved state from here until a mission matches. (page.waitForFunction
 * does not await an async predicate: the pending promise counts as true.)
 */
async function waitForMission(
  page: Page,
  matches: (d: Deployment) => boolean,
  timeoutMs = 15_000
): Promise<Deployment> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const { deployments } = await page.evaluate(() => window.mechbay.getState())
    const found = deployments.find(matches)
    if (found) return found
    if (Date.now() > deadline) throw new Error(`no mission matched within ${timeoutMs} ms`)
    await page.waitForTimeout(500)
  }
}

async function verifyDemo(app: ElectronApplication): Promise<void> {
  const page = await app.firstWindow()
  await settle(page)
  // Demo mode links one facility; every mission can go there.
  const ids = await page.evaluate(async () => {
    const s = await window.mechbay.getState()
    const facility = s.facilities.find((f) => f.path)
    if (!facility) throw new Error('demo mode linked no facility')
    const sent: string[] = []
    for (let i = 0; i < 4; i++) {
      const r = await window.mechbay.deployStart({
        companionId: s.companions[i].id,
        facilityId: facility.id,
        taskPrompt: `Verification mission ${i + 1}`
      })
      sent.push(r.deploymentId)
    }
    return sent
  })
  await page.getByText('Queued · #1 in line').first().waitFor({ timeout: 10_000 })
  await page.screenshot({ path: join(out, 'queue.png') })

  await page.getByRole('button', { name: 'Cancel mission' }).first().click()
  await page.getByRole('button', { name: 'Yes, cancel' }).click()
  await waitForMission(page, (d) => d.id === ids[3] && d.status === 'cancelled')
  await page.screenshot({ path: join(out, 'cancelled.png') })

  await page.getByRole('button', { name: 'Recall mech' }).first().click()
  await page.getByRole('button', { name: 'Yes, recall' }).click()
  const recalled = await waitForMission(
    page,
    (d) => d.status === 'cancelled' && d.summary === 'Recalled by the commander.'
  )
  await page.screenshot({ path: join(out, 'recalled.png') })

  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  // Each mech's card has its own Autonomy control.
  await page.getByRole('radiogroup', { name: 'Autonomy' }).first().waitFor()
  // The panel slides in over a quarter second.
  await page.waitForTimeout(600)
  await page.screenshot({ path: join(out, 'autonomy.png') })

  const final = await page.evaluate(() => window.mechbay.getState())
  const statuses = ids.map((id) => final.deployments.find((d) => d.id === id)?.status)
  // Three ran, the fourth waited and was cancelled, one runner was recalled.
  assert.equal(statuses.filter((s) => s === 'cancelled').length, 2, `statuses ${statuses}`)
  assert.ok(ids.slice(0, 3).includes(recalled.id), 'the recalled mission was one that ran')
  console.log(JSON.stringify({ mode: 'demo', statuses, cancelled: true, recalled: true }))
}

function makeRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), 'mechbay-verify-repo-'))
  writeFileSync(join(repo, 'hello.txt'), 'first line\nsecond line\n')
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '.')
  git(
    '-c',
    'user.email=verify@mechbay.local',
    '-c',
    'user.name=MechBay Verify',
    'commit',
    '-q',
    '-m',
    'init'
  )
  return repo
}

async function verifyReal(app: ElectronApplication, repo: string): Promise<void> {
  const page = await app.firstWindow()
  await settle(page)

  // Link the repo the way a person does (click a building, pick a folder),
  // with the folder picker answered by this script.
  await app.evaluate(({ dialog }, picked) => {
    dialog.showOpenDialog = (async () => ({ canceled: false, filePaths: [picked] })) as never
  }, repo)

  const result = await page.evaluate(async () => {
    const s = await window.mechbay.getState()
    const unlinked = s.facilities.find((f) => !f.path)
    if (!unlinked) throw new Error('no unlinked building to link')
    const facility = await window.mechbay.linkFacility(unlinked.id)
    if (!facility) throw new Error('linking the repo was cancelled')
    const claude = s.companions.find((c) => (c.runtime ?? c.family) === 'claude')
    if (!claude) throw new Error('no Claude mech')

    let missionId = ''
    let started = 0
    // null when no readable line arrives within two minutes.
    const firstLine = new Promise<number | null>((resolveFirst) => {
      const timer = setTimeout(() => {
        off()
        resolveFirst(null)
      }, 120_000)
      const off = window.mechbay.logs.subscribe((entries) => {
        const readable = entries.some(
          (e) => e.deploymentId === missionId && e.stream === 'stdout' && e.text.trim()
        )
        if (readable) {
          clearTimeout(timer)
          off()
          resolveFirst(Date.now() - started)
        }
      })
    })
    started = Date.now()
    const { deploymentId } = await window.mechbay.deployStart({
      companionId: claude.id,
      facilityId: facility.id,
      taskPrompt: 'Append the line "third line" to hello.txt.'
    })
    missionId = deploymentId
    return { deploymentId, firstLineMs: await firstLine }
  })

  const mission = await waitForMission(
    page,
    (d) => d.id === result.deploymentId && ENDED.includes(d.status),
    240_000
  )
  console.log(
    JSON.stringify({
      mode: 'real',
      status: mission.status,
      summary: mission.summary,
      diffStats: mission.diffStats ?? null,
      firstLineMs: result.firstLineMs,
      under5s: result.firstLineMs !== null && result.firstLineMs < 5000
    })
  )
  assert.equal(mission.status, 'completed', 'the real mission must complete')
  assert.match(readFileSync(join(repo, 'hello.txt'), 'utf8'), /third line/)

  // A completed mission opens its debrief on its own (App.tsx debriefQueue),
  // and that dialog covers the sortie board, so wait for it, not a click.
  await page
    .getByRole('dialog', { name: /debrief/i })
    .waitFor({ state: 'visible', timeout: 15_000 })
  await page.waitForTimeout(1200)
  await page.screenshot({ path: join(out, 'real-debrief.png') })
}

const repo = demo ? undefined : makeRepo()
let app: ElectronApplication | undefined
try {
  const launched = await launchMechbay({ demo, profile })
  app = launched.app
  await (repo ? verifyReal(app, repo) : verifyDemo(app))
  assert.deepEqual(launched.errors, [], 'renderer errors')
} finally {
  // Close first: the app (and any agent it started) holds the folders open.
  try {
    await closeMechbay(app)
  } finally {
    for (const dir of [profile, repo]) {
      if (dir) rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
}
