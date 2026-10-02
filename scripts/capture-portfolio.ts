/** Capture the real Electron app in an isolated simulation workspace. */
import { _electron } from 'playwright-core'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'
import assert from 'node:assert/strict'

const root = resolve(import.meta.dirname, '..')
const output = join(root, 'artifacts', 'portfolio')
mkdirSync(output, { recursive: true })
const profile = mkdtempSync(join(tmpdir(), 'mechbay-portfolio-'))
const env = { ...process.env, MECHBAY_DEMO: '1' }
delete env.ELECTRON_RUN_AS_NODE
const app = await _electron.launch({
  args: ['.', '--demo', `--user-data-dir=${profile}`, '--force-device-scale-factor=1'],
  cwd: root,
  env
})
const errors: string[] = []
let stopRecording: (() => Promise<void>) | undefined
try {
  const actualProfile = await app.evaluate(({ app }) => app.getPath('userData'))
  assert.equal(resolve(actualProfile), resolve(profile), 'Capture must use an isolated profile')
  await app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0].setContentSize(1600, 1000)
  })
  const page = await app.firstWindow()
  page.on('pageerror', (error) => errors.push(error.message))
  await page.waitForFunction(() =>
    Boolean(window.__mechbayState?.companions.every((c) => c.cliAvailable))
  )
  await page.locator('.command-header').waitFor()
  await page.waitForTimeout(3500)
  await page.evaluate(() => document.fonts.ready)
  await page.screenshot({ path: join(output, 'mechbay-command.png') })
  const fits = await page.locator('.bay-canvas').evaluate((element) => {
    const parent = element.getBoundingClientRect()
    const canvas = element.querySelector('canvas')!.getBoundingClientRect()
    return canvas.height <= parent.height + 2 && canvas.width <= parent.width + 2
  })
  assert.ok(fits, 'The entire canvas must fit in the tactical viewport')
  if (!process.argv.includes('--preview')) {
    const frames = join(output, `frames-${Date.now()}`)
    mkdirSync(frames)
    let index = 0
    const recordingStartedAt = Date.now()
    let recording = true
    const loop = (async (): Promise<void> => {
      while (recording) {
        await page.screenshot({
          path: join(frames, `frame-${String(index++).padStart(5, '0')}.jpg`),
          type: 'jpeg',
          quality: 88
        })
        await page.waitForTimeout(140)
      }
    })()
    stopRecording = async (): Promise<void> => {
      recording = false
      await loop
      writeFileSync(
        join(output, 'recording.json'),
        JSON.stringify(
          { frames, count: index, durationMs: Date.now() - recordingStartedAt },
          null,
          2
        )
      )
    }
    await page.waitForTimeout(900)
    await page.getByRole('button', { name: 'Prepare deployment' }).click()
    const dialog = page.getByRole('dialog').filter({ hasText: 'DEPLOY:' })
    await dialog
      .getByRole('textbox', { name: 'Task prompt' })
      .fill('Survey the reactor controls and document the telemetry calibration.')
    await page.waitForTimeout(900)
    await page.screenshot({ path: join(output, 'mechbay-deploy.png') })
    await dialog.getByRole('button', { name: 'Deploy mission', exact: true }).click()
    await page.getByRole('log').waitFor()
    // Logs left saved state in v1.4.2, so count rendered rows instead: seven
    // lines plus the mission's separator row.
    await page.waitForFunction(
      () => (document.querySelector('[role="log"]')?.children.length ?? 0) >= 8
    )
    await page.screenshot({ path: join(output, 'mechbay-mission.png') })
    await page.getByRole('button', { name: 'OPERATIONS', exact: true }).click()
    await page.waitForTimeout(2200)
    await page.screenshot({ path: join(output, 'mechbay-operations.png') })
    await page.getByRole('button', { name: 'LIVE LOG', exact: true }).click()
    const debrief = page.getByRole('dialog').filter({ hasText: 'MISSION DEBRIEF' })
    await debrief.waitFor({ timeout: 45000 })
    const result = await page.evaluate(() =>
      window.__mechbayState?.deployments.find((d) => d.status === 'completed')
    )
    assert.ok(
      result?.diffStats && result.diffStats.filesChanged > 0,
      'Demo must produce actual file changes'
    )
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(output, 'mechbay-debrief.png') })
    await page.waitForTimeout(2800)
    await debrief.getByRole('button', { name: 'ACKNOWLEDGED' }).click()
    await page.getByRole('button', { name: 'OPERATIONS', exact: true }).click()
    await page.waitForTimeout(800)
    await page.screenshot({ path: join(output, 'mechbay-results.png') })
    await stopRecording()
    stopRecording = undefined
    // Completed reports remain inspectable after dismissal.
    await page.getByRole('button', { name: 'Review mission: Atlas-Prime', exact: true }).click()
    await debrief.waitFor()
    await page.keyboard.press('Escape')
    await page.getByRole('button', { name: 'Select Raven-Prime', exact: true }).click()
    assert.equal(
      await page.locator('#dispatch-mech').inputValue(),
      await page.evaluate(
        () => window.__mechbayState?.companions.find((c) => c.name === 'Raven-Prime')?.id
      )
    )
    await page.getByRole('button', { name: /Inspect RVN personality/ }).click()
    await page.screenshot({ path: join(output, 'mechbay-journal.png') })
    await page.getByRole('button', { name: 'OPERATIONS', exact: true }).click()
    await page.getByRole('button', { name: '02 Research Lab Browse' }).click()
    await page.getByRole('button', { name: 'FILES', exact: true }).waitFor()
    await page.getByRole('button', { name: 'OPERATIONS', exact: true }).click()
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0].setContentSize(1100, 740)
    })
    await page.waitForTimeout(600)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      'No horizontal overflow at laptop width'
    )
    await page.screenshot({ path: join(output, 'mechbay-laptop.png') })
    writeFileSync(
      join(output, 'verification.json'),
      JSON.stringify(
        { capturedAt: new Date().toISOString(), profile, deployment: result, errors },
        null,
        2
      )
    )
  }
  assert.deepEqual(errors, [], 'No renderer errors')
  console.log(`Capture verified: ${output}`)
} finally {
  await stopRecording?.()
  await app.close()
}
