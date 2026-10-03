/** Verify the built portfolio and project landing page with locally installed Chromium. */
import { chromium } from 'playwright-core'
import { mkdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import assert from 'node:assert/strict'

const output = resolve(import.meta.dirname, '../artifacts/portfolio')
const portfolioRoot = process.env.MECHBAY_PORTFOLIO
if (!portfolioRoot) throw new Error('Set MECHBAY_PORTFOLIO to the portfolio site checkout')
const browser = await chromium.launch({
  executablePath: join(
    process.env.LOCALAPPDATA!,
    'ms-playwright/chromium-1217/chrome-win64/chrome.exe'
  ),
  headless: true
})
const errors: string[] = []
const checks: unknown[] = []
try {
  for (const width of [320, 390, 768, 1024, 1440]) {
    const page = await browser.newPage({
      viewport: { width, height: 1000 },
      reducedMotion: 'reduce'
    })
    page.on('pageerror', (error) => errors.push(error.message))
    page.on('response', (response) => {
      if (/localhost|127\.0\.0\.1/.test(response.url()) && response.status() >= 400)
        errors.push(`${response.status()} ${response.url()}`)
    })
    await page.goto('http://localhost:4387/portfolio/', { waitUntil: 'networkidle' })
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Portfolio overflow at ${width}`
    )
    const card = page.locator('#mechbay')
    await card.scrollIntoViewIfNeeded()
    await card.locator('.project-evidence summary').click()
    for (const img of await card.locator('.evidence-gallery img').all()) {
      await img.scrollIntoViewIfNeeded()
      await img.evaluate((element: HTMLImageElement) => element.decode())
    }
    assert.equal(await card.locator('.evidence-gallery a').count(), 3)
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Open gallery overflow at ${width}`
    )
    for (const link of await card.locator('.evidence-gallery a').all()) {
      const response = await page.request.get(
        new URL((await link.getAttribute('href'))!, page.url()).href
      )
      assert.ok(response.ok(), 'Screenshot link must work')
    }
    const video = card.locator('video')
    assert.equal(await video.getAttribute('preload'), 'none')
    assert.equal(await video.getAttribute('autoplay'), null)
    if ([390, 1440].includes(width)) {
      await video.evaluate((element: HTMLVideoElement) => element.load())
      await page.waitForFunction(
        () => (document.querySelector('#mechbay video') as HTMLVideoElement).readyState >= 2
      )
      const metadata = await video.evaluate((element: HTMLVideoElement) => ({
        width: element.videoWidth,
        height: element.videoHeight,
        duration: element.duration
      }))
      assert.equal(metadata.width, 1280)
      assert.ok(metadata.duration >= 23 && metadata.duration <= 25)
      await video.evaluate(async (element: HTMLVideoElement) => {
        await element.play()
        await new Promise<void>((done) => element.requestVideoFrameCallback(() => done()))
        element.pause()
      })
      await page.waitForTimeout(400)
      checks.push({ video: metadata })
    }
    if ([390, 1440].includes(width)) {
      await card.screenshot({
        path: join(output, `portfolio-${width}.png`),
        style: 'header, .skip-link, astro-dev-toolbar { visibility: hidden !important; }'
      })
    }
    checks.push({ portfolioWidth: width, overflow: false, gallery: 'verified' })
    await page.goto('http://127.0.0.1:4174/', { waitUntil: 'networkidle' })
    await page.evaluate(() => document.fonts.ready)
    if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) {
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('*')]
            .filter((element) => element.getBoundingClientRect().right > innerWidth + 1)
            .slice(0, 12)
            .map((element) => ({
              tag: element.tagName,
              class: element.className,
              text: element.textContent?.slice(0, 60),
              right: element.getBoundingClientRect().right
            }))
        )
      )
      await page.screenshot({ path: join(output, `landing-overflow-${width}.png`), fullPage: true })
    }
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollWidth > innerWidth),
      false,
      `Landing overflow at ${width}`
    )
    for (const img of await page.locator('img').all()) {
      await img.scrollIntoViewIfNeeded()
      await img.evaluate((element: HTMLImageElement) => element.decode())
    }
    if ([390, 1440].includes(width)) {
      await page.locator('video').evaluate((element: HTMLVideoElement) => element.load())
      await page.waitForFunction(
        () => (document.querySelector('video') as HTMLVideoElement).readyState >= 2
      )
      await page.locator('video').evaluate(async (element: HTMLVideoElement) => {
        await element.play()
        await new Promise<void>((done) => element.requestVideoFrameCallback(() => done()))
        element.pause()
      })
      await page.waitForTimeout(400)
      await page.evaluate(() => scrollTo(0, 0))
      await page.screenshot({ path: join(output, `landing-${width}.png`), fullPage: true })
    }
    checks.push({ landingWidth: width, overflow: false })
    await page.close()
  }
  const noJs = await browser.newPage({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 900 }
  })
  await noJs.goto('http://localhost:4387/portfolio/')
  await noJs.locator('#mechbay summary').click()
  assert.equal(await noJs.locator('#mechbay details').getAttribute('open'), '')
  await noJs.locator('#mechbay .evidence-gallery img').first().scrollIntoViewIfNeeded()
  await noJs
    .locator('#mechbay .evidence-gallery img')
    .first()
    .evaluate((element: HTMLImageElement) => element.decode())
  assert.ok(
    await noJs
      .locator('#mechbay .evidence-gallery img')
      .first()
      .evaluate((element: HTMLImageElement) => element.complete && element.naturalWidth === 1600)
  )
  checks.push({ noJavaScript: 'Gallery and image links work' })
  await noJs.close()
  assert.deepEqual(errors, [])
  const portfolioOutput = resolve(portfolioRoot, 'output/mechbay-refresh')
  mkdirSync(portfolioOutput, { recursive: true })
  for (const width of [390, 1440])
    copyFileSync(
      join(output, `portfolio-${width}.png`),
      join(portfolioOutput, `portfolio-${width}.png`)
    )
  writeFileSync(
    join(output, 'showcase-verification.json'),
    JSON.stringify({ verifiedAt: new Date().toISOString(), checks, errors }, null, 2)
  )
  console.log(JSON.stringify(checks, null, 2))
} finally {
  await browser.close()
}
