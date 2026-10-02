import { app, shell, BrowserWindow } from 'electron'
import { dirname, join, resolve, sep } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import Store from 'electron-store'
import icon from '../../resources/icon.png?asset'
import { StateManager } from './state-manager'
import { openStateStore } from './state-store'
import { scaffoldSoulAndMemory } from './soul-memory'
import { FsReader } from './fs-reader'
import { ClaudeRunner } from './runners/claude'
import { CodexRunner } from './runners/codex'
import { KimiRunner } from './runners/kimi'
import { GeminiRunner } from './runners/gemini'
import { HermesRunner } from './runners/hermes'
import { SimRunner } from './runners/sim'
import { collectSecretValues, registerIpc } from './ipc'
import { redactSecrets } from './redact'
import { LogStore, logDirFor, prepareLogStore } from './log-store'
import { MissionRegistry, shutdownMissions } from './mission-registry'
import { hasSameOrigin, isOpenableExternalUrl } from './external-links'
import { MissionAlerts } from './mission-alerts'
import { runCliAvailabilityCheck } from './cli-check'
import { IPC } from '../shared/ipc-channels'
import type { Runner } from './runners/types'
import type { AgentFamily } from '../shared/types'
import { SecretsManager } from './secrets'
import { isDemoMode, linkDemoFacility, seedDemoWorkspace } from './demo-mode'

function createWindow(): BrowserWindow {
  const mainWindow = new BrowserWindow({
    width: 1280,
    height: 800,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0a0805',
    title: 'MechBay',
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // The preload only uses electron's contextBridge and ipcRenderer, so the
      // renderer runs inside Chromium's OS-level sandbox.
      sandbox: true
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow.show()
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    if (isOpenableExternalUrl(details.url)) {
      shell.openExternal(details.url).catch((err) => {
        console.error('[main] Could not open link in the browser:', err)
      })
    }
    return { action: 'deny' }
  })
  // The window only ever shows the bay; it never navigates anywhere else.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const devUrl = is.dev ? process.env['ELECTRON_RENDERER_URL'] : undefined
    if (!hasSameOrigin(url, devUrl)) event.preventDefault()
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

// Smoke runs (scripts/smoke-electron.ts) set MECHBAY_REQUIRE_USER_DATA to their
// throwaway profile. If the launch did not land there, exit before the lock
// file, stores or companion files touch the real profile.
const requiredUserData = process.env.MECHBAY_REQUIRE_USER_DATA
if (requiredUserData) {
  const normalize = (p: string): string =>
    process.platform === 'win32' ? resolve(p).toLowerCase() : resolve(p)
  const actual = app.getPath('userData')
  if (normalize(actual) !== normalize(requiredUserData)) {
    console.error(`[main] userData is ${actual}, expected ${requiredUserData}. Exiting.`)
    // process.exit, not app.exit: nothing below this line may run.
    process.exit(1)
  }
}

// Single-instance lock: a second launch focuses the existing window instead
// of starting a competing process. Two instances would fight over Chromium's
// GPU disk cache (the benign "Unable to move the cache: Access is denied" boot
// error) AND — the real hazard — both write the same electron-store state file
// and could clobber each other's saved bay. First instance wins; later
// launches bounce to it.
const gotSingleInstanceLock = app.requestSingleInstanceLock()
if (!gotSingleInstanceLock) {
  app.quit()
}

app.on('second-instance', () => {
  const [existing] = BrowserWindow.getAllWindows()
  if (existing) {
    if (existing.isMinimized()) existing.restore()
    existing.focus()
  }
})

app.whenReady().then(() => {
  if (!gotSingleInstanceLock) return
  electronApp.setAppUserModelId('com.sam.mechbay')

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  const win = createWindow()

  // ─── MechBay subsystems ───────────────────────────────────────
  const demoMode = isDemoMode()
  const userData = app.getPath('userData')
  const opened = openStateStore({
    dir: userData,
    name: demoMode ? 'mechbay-state-demo' : 'mechbay-state',
    createStore: (name) => new Store({ name })
  })
  const state = new StateManager(opened.store, userData, { startupNotice: opened.notice })
  const secrets = new SecretsManager(new Store({ name: 'mechbay-secrets' }))

  if (demoMode) {
    const demoDir = join(app.getPath('userData'), 'demo-facility')
    seedDemoWorkspace(demoDir)
    linkDemoFacility(state, demoDir)
  }

  // Scaffold soul.md + memory.md for every companion on boot. Idempotent:
  // only writes templates if the files don't exist. A companion's
  // personality is persistent from this point on — edits to soul.md carry
  // forward, and memory.md accretes on every deploy.
  for (const companion of state.getState().companions) {
    try {
      scaffoldSoulAndMemory(companion.mechClass, companion.name, {
        soulPath: companion.soulPath,
        memoryPath: companion.memoryPath
      })
    } catch (err) {
      console.error(`[boot] scaffoldSoulAndMemory(${companion.name}) failed:`, err)
    }
  }

  // The Kimi runner shells out to our bundled Fireworks wrapper
  // (scripts/kimi_fireworks.py). app.getAppPath() resolves to the repo
  // root in dev. In packaged builds it points INSIDE app.asar, which
  // python can't read, so electron-builder.yml asarUnpacks the script and
  // we redirect to the unpacked copy. The replace is a no-op in dev.
  const kimiScriptPath = join(app.getAppPath(), 'scripts', 'kimi_fireworks.py').replace(
    `app.asar${sep}`,
    `app.asar.unpacked${sep}`
  )

  const runners: Record<AgentFamily, Runner> = demoMode
    ? {
        claude: new SimRunner('claude'),
        codex: new SimRunner('codex'),
        kimi: new SimRunner('kimi'),
        gemini: new SimRunner('gemini'),
        hermes: new SimRunner('hermes')
      }
    : {
        claude: new ClaudeRunner(),
        codex: new CodexRunner(),
        kimi: new KimiRunner({ scriptPath: kimiScriptPath, secrets }),
        gemini: new GeminiRunner(),
        hermes: new HermesRunner()
      }

  // Filesystem reader is whitelisted to (a) every facility's project path
  // and (b) each companion's barracks dir (so the File Browser can view
  // soul.md / memory.md). Whitelist is rebuilt on every state change so
  // adding/removing a facility or swapping a facility's path takes effect
  // immediately.
  const buildFsWhitelist = (): string[] => {
    const s = state.getState()
    return [
      ...s.facilities.map((f) => f.path).filter((p) => p && p.length > 0),
      ...s.companions.map((c) => dirname(c.soulPath))
    ]
  }
  const fsReader = new FsReader(buildFsWhitelist())
  state.on('stateChanged', () => fsReader.updateWhitelist(buildFsWhitelist()))

  // Mission logs live in per-mission files next to the saved bay, in a
  // separate folder for demo mode. Each flushed batch goes to the window.
  const logs = new LogStore({
    dir: logDirFor(userData, demoMode),
    onEntries: (entries) => {
      if (!win.isDestroyed()) win.webContents.send(IPC.LOG_STREAM, entries)
    }
  })
  // A failure here must not stop the bay from opening: missions still log
  // live, only the old-log import or cleanup is skipped.
  try {
    const bootSecrets = collectSecretValues({ runners, secrets })
    prepareLogStore(logs, state, { redact: (text) => redactSecrets(text, bootSecrets) })
  } catch (err) {
    console.error('[boot] preparing mission logs failed:', err)
  }
  // Closing MechBay recalls every running mission and cancels every queued
  // one, then writes the last log lines (shutdownMissions does the flush),
  // bounded at 8 seconds so a stuck agent cannot hold the app open.
  const missions = new MissionRegistry()
  let quitting = false
  app.on('before-quit', (event) => {
    // A second quit while shutting down waits for the first; app.exit below
    // ends the app without emitting before-quit again.
    event.preventDefault()
    if (quitting) return
    quitting = true
    void shutdownMissions({ state, missions, logs, timeoutMs: 8000 }).finally(() => app.exit(0))
  })

  registerIpc({ win, state, runners, fsReader, secrets, demoMode, logs, missions })

  // Crash recovery: any deployment stuck in an active status is a
  // zombie from a previous crash or force-quit. Mark them failed and
  // send the list to the renderer once it's ready to receive it.
  const zombies = state.sweepZombieDeployments()
  if (zombies.length > 0) {
    const push = (): void => {
      if (!win.isDestroyed()) {
        win.webContents.send(IPC.RECOVERY_ZOMBIES, zombies)
      }
    }
    // If the page is already loaded when we hit this code path, send
    // immediately; otherwise wait for did-finish-load.
    if (win.webContents.isLoading()) {
      win.webContents.once('did-finish-load', push)
    } else {
      push()
    }
  }

  // Desktop mission alerts: notifications + taskbar flash/progress when a
  // deployment finishes, fails, or needs input while unfocused. Must be
  // constructed AFTER the zombie sweep above: the sweep flips interrupted
  // missions to 'failed', and the window isn't shown yet (so it reads as
  // unfocused), which would fire a "mech is down" OS notification for
  // every crash-recovered mission on top of the in-app recovery modal.
  // Wired for demo mode too (it's the showcase); capture scripts keep the
  // window focused so they never trigger a real notification.
  new MissionAlerts({ win, state })

  // Probe CLI availability in the background — don't block window show.
  // A missing CLI surfaces as a NOT DEPLOYABLE overlay once the state
  // update lands (usually within a second of boot).
  void runCliAvailabilityCheck(state, runners).catch((err) => {
    console.error('[boot] runCliAvailabilityCheck failed:', err)
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit()
  }
})
