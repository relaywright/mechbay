/* eslint-disable @typescript-eslint/explicit-function-return-type */
/**
 * Render the 1280×640 link-preview card from scripts/social-preview/index.html
 * into site/social-preview.png and docs/social-preview.png.
 *
 *   npm run render:social
 *
 * Runs inside the project's own Electron (no browser download) with an
 * offscreen window, so the card is reproducible on every platform the app
 * builds on. The template reuses the bundled fonts, the current bay
 * screenshot and the mech portraits, so refreshing the screenshot and
 * running this keeps the card in step with the app.
 */
import { app, BrowserWindow } from 'electron'
import { writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const WIDTH = 1280
const HEIGHT = 640
const outputs = [join(root, 'site', 'social-preview.png'), join(root, 'docs', 'social-preview.png')]

/**
 * @param {string} name
 * @returns {void}
 */
function step(name) {
  if (process.env.MECHBAY_RENDER_DEBUG) console.error(`[render] ${name}`)
}

/** @returns {Promise<void>} */
async function render() {
  const win = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    useContentSize: true,
    webPreferences: { offscreen: true, backgroundThrottling: false }
  })
  win.setContentSize(WIDTH, HEIGHT)
  await win.loadURL(pathToFileURL(join(root, 'scripts', 'social-preview', 'index.html')).href)
  step('loaded')
  await win.webContents.executeJavaScript(
    'document.fonts.ready.then(() => Promise.all([...document.images].map((i) => i.decode())))'
  )
  step('fonts and images ready')
  // One more paint after fonts and images settle, then capture.
  await new Promise((done) => setTimeout(done, 300))
  const captured = await win.capturePage()
  const { width, height } = captured.getSize()
  step(`captured ${width}x${height}`)
  // Offscreen windows can come back a pixel short of the content size on
  // some platforms; the page itself is fixed at 1280×640, so a crop or a
  // one-pixel resize is exact enough for a link-preview card.
  const image =
    width === WIDTH && height === HEIGHT
      ? captured
      : captured.resize({ width: WIDTH, height: HEIGHT, quality: 'best' })
  const png = image.toPNG()
  for (const output of outputs) writeFileSync(output, png)
  console.log(`wrote ${outputs.join(' and ')} (${png.length} bytes)`)
}

app.disableHardwareAcceleration()
// A stuck paint must not hang a release script.
const watchdog = setTimeout(() => {
  console.error('render-social-preview: timed out after 30 s')
  app.exit(2)
}, 30_000)

// No top-level await here: Electron's ready event waits for the entry module
// to finish loading, so awaiting app.whenReady() at the top level deadlocks.
app.whenReady().then(
  () =>
    render().then(
      () => {
        clearTimeout(watchdog)
        app.exit(0)
      },
      (error) => {
        console.error(error)
        app.exit(1)
      }
    ),
  (error) => {
    console.error(error)
    app.exit(1)
  }
)
