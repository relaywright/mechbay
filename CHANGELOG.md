# Changelog

## v1.4.3 - 2026-10-02

Polish on top of v1.4.2: the bay fills its panel, crew cards stay tidy,
and error messages read like sentences.

### Fixed

- **The whole bay shows, at any zoom.** The bay was drawn on a
  fixed-shape canvas centered in the wider panel. On a wide window that
  clipped the tip of the deck next to Foundry, and zooming in cut the floor
  off along straight vertical edges. The canvas now fills the panel: the
  bay stays the same size, a wide window shows more hangar around it, and
  the radar minimap sits in the panel's top-right corner.
- **The mouse wheel zooms toward the cursor.** Zooming in always drifted
  toward Foundry, wherever the cursor was. The building under the cursor
  now stays under it.
- **Crew cards never overlap.** On narrow cards the mech's status ran into
  its stat line. The two now share one row, and a card too narrow for both
  hides the stat line while the mech is busy. The DEPLOYED tag on a card
  is hidden whenever the card is too narrow to show it clear of the
  portrait, instead of being cut off as "DEPLOYE".
- **Facility names stay on top.** A mech working at a facility used to
  stand over the facility's name. Names now draw above every mech and
  building, and the map's corner labels have a dark halo so the floor
  running under them no longer washes them out.
- **No false "lance at capacity" warning.** Deploying with a free slot
  briefly showed LANCE AT CAPACITY and a "holding position" radio line
  before the mech set off. Both now appear only when the mission really
  waits, and a holding line still waiting its turn on screen is dropped if
  the mission sets off first. Atlas's working line, which also sounded
  like a queue warning, now says "Digging in at ...".
- **Plain error messages.** A failed action showed Electron's wrapper text
  ("Error invoking remote method ...") in front of the real reason. Every
  panel now shows only the reason, in full, even when it names a folder
  with brackets in its name.
- **Old logs that fail to move are no longer silent.** When upgrading a
  v1.4.0 bay, if a mission's log could not be written to its new file (a
  full disk, a locked folder), MechBay now says so at startup and names the
  backup that still holds every line. A log cut short by a full disk is
  removed, so it is never mistaken for a complete one.
- The Read only hint now says exactly what it promises: the agent can look
  through the project, and the CLI blocks any change to project files.

### Changed

- Development dependencies: Vitest 5, Prettier 3.9.9, and newer
  checkout and secret-scan actions in CI.
- The project now lives at github.com/relaywright/mechbay. Installers,
  links and the "please report this" messages point there.

## v1.4.2 - 2026-10-02

A release about trust in the hangar: your bay survives upgrades, missions
wait their turn fairly, you can call a mech back, and you choose how much
each mech may do.

### Added

- **Recall.** Cancel a waiting mission, or recall a running one, from the
  sortie board, the live log or the mech's panel. Recall ends the agent and
  every program it started, and the mech walks home. A recalled mission
  stays recalled, even if the agent exits cleanly a moment later.
- **Autonomy.** Each mech has a level: Read only, Edit files or Full.
  Claude Code and Codex enforce it through their own permission flags. A
  level a runtime cannot enforce is shown disabled with the reason, never
  approximated. Every mech starts at Edit files, including mechs from an
  upgraded bay, and the debrief lists anything the agent was blocked from
  doing. Edit files can be more than v1.4.1 allowed (Claude refused edits
  there, and Codex may have run read only), so choose Read only in a
  mech's settings if that is what you want. Switching a mech to a runtime that would let it do more asks
  first.
- **Claude shows its work.** Real Claude missions show each step live
  (what it reads, edits and runs) instead of a silent log, and every
  mission opens with a line saying the agent has launched. Claude can take
  several seconds to load its own plugins and settings before its first
  step.
- **Logs are saved per mission** and come back after a restart. Each
  mission keeps its first 20,000 lines; later lines still show live. Logs
  move out of the saved bay file, so that file stays small.

### Changed

- **Text you can read.** Nothing in the app is smaller than 11px any more,
  log and diff text is 13px, and the faintest grays are brighter. Bay
  labels, unit plates and map tags grew to match.
- **The queue is fair.** Missions you send while every slot is busy start
  in the order you sent them, every free slot fills, and a mech takes one
  mission at a time. A waiting mission shows its place in line.
- **Your bay survives upgrades.** Saved data is upgraded in place, and the
  old file is copied next to it first. A save from a newer MechBay, or one
  that cannot be upgraded, is left untouched and MechBay tells you so. A
  damaged save is copied aside before a fresh bay starts.

### Fixed

- **Closing MechBay stops its agents.** Quitting recalls every running
  mission, cancels the waiting ones, and waits (up to 8 seconds) for each
  to save its outcome before the app exits. No new mission can start while
  it closes.
- **A leftover program can no longer keep a mission open forever.** If the
  agent exits but a program it started (a dev server, say) still holds its
  output, MechBay stops reading 2 seconds later and finishes the mission.
- **Mission time and stats are honest.** Time in the field starts when the
  mission leaves the line, not when you sent it, and the header's heat
  gauge counts the same slots the queue does.

### Going back to an earlier version

Your bay from before the upgrade is kept as
`mechbay-state.v2-backup-<date>.json` in `%APPDATA%\mechbay` (Windows),
`~/Library/Application Support/mechbay` (macOS) or `~/.config/mechbay`
(Linux). It is an exact copy, so any mission logs from v1.4.0 inside it
are kept as they were, unredacted.

- **v1.4.1** cannot read the upgraded bay. It leaves the file alone and
  opens a temporary bay that is not saved. To go back: quit MechBay,
  rename the backup to `mechbay-state.json`, then open v1.4.1.
- **v1.4.0** does not recognize the upgraded bay and replaces it with a
  fresh one, with no copy. Rename the backup to `mechbay-state.json`
  **before** you open v1.4.0, and your bay comes back.

## v1.4.1 - 2026-10-02

A trust release: the app, the README and the landing page now say only what
is true, the window that draws the bay can reach only MechBay's own bridge,
and reading a mission's project no longer runs that project's programs.

### Fixed

- **Journal save race.** A slow soul read for one mech could land in another
  mech's Journal and be saved into its `soul.md`. Late responses are now
  dropped, and the Journal and Files panels reset when the selection
  changes. If a soul can't be read, the Journal can't save over it.
- **Stale files.** Switching facilities or files quickly no longer shows the
  previous facility's files or the previous file's contents.
- **Ctrl+Enter deploy** always uses the current mission settings.
- **Blurry facility labels on 4K screens.** Labels now render at the
  camera's zoom, so they stay sharp at every window size and zoom level.
- **The simulated log quoted the mech's soul.** `TASK //` now shows only the
  task you typed.
- **A newer saved bay is never wiped.** If a later MechBay has saved your
  bay, this version leaves that file untouched and starts a temporary bay
  that is not saved, so going back from a later version to this one never
  costs you your bay.
- **The demo works when your git signs commits.** If your global git
  settings sign commits or run hooks, the demo still saves its starting
  point, so its first debrief shows only what the mech changed.
- **One line per mission in memory.** A task typed over several lines no
  longer breaks the mech's `memory.md` or the next mission's prompt.
- Boot splash version, plurals ("1 PROJECT CONNECTED"), and every em dash in app text.

### Security

- **Sandboxed renderer.** The window that draws the bay runs in Chromium's
  sandbox and can reach only the MechBay bridge (`window.mechbay`). It
  cannot navigate away from the bay, and links it opens go to your browser
  only as https.
- **The window cannot name places on disk.** Project scans always use the
  folder from Settings, bulk import accepts only folders that scan found,
  and the Journal accepts only the ID of a mech that exists.
- **Reading a project's git history no longer runs the project's
  programs.** Every git call behind the Mission Debrief switches off hooks,
  fsmonitor, external diff and textconv helpers, network transports and the
  filter drivers the project's own config defines, shows submodules as a
  commit pointer only, and runs with a clean git environment. If a
  project's git settings can't be read safely, the debrief says the diff is
  unavailable. The remaining accepted risks are listed in
  `docs/engineering/decisions.md`.
- **Known keys are hidden.** Stored API keys and secret-looking environment
  variables (8 characters or longer, multi-line keys line by line) are
  replaced with `[redacted]` in the live log, saved logs,
  failure summaries, the mech's memory file and saved task text. The Kimi
  wrapper's shell commands run without any runtime's API key, and Kimi keys
  come only from the environment or Settings (no key file).
- Electron 39.8.10 and Vitest 4.1.11 close 8 published advisories.

### Changed

- **Landing page** written for people who don't write code: what MechBay
  does in one sentence, a Download button for your system, what the project
  demonstrates, and link previews for LinkedIn and Slack. New address:
  `mechbay.samalbanese.com`.
- **Honest runtime labels.** Kimi, Gemini and bring-your-own-agent mechs say
  "not verified by the author" in the app, the README and the landing page.

### Engineering

- One verify workflow (type check of app and tests, lint, tests, build) runs
  on Windows and Linux for every pull request and gates every release.
- A public-claims test keeps the README and landing page from drifting away
  from the code.
- `scripts/smoke-electron.ts` boots the built app in a throwaway profile and
  checks the sandbox; the app refuses to start in any other profile when the
  smoke test asks it to.
- A curated engineering log: decisions and post-mortems in
  `docs/engineering/`.

## v1.4.0 - 2026-09-29

First public release with downloadable installers.

### Added (2026-09-25 level-up push)

- **Living bay.** Deck plate variation, hazard-striped landing pads under
  each mech, facility foundations, power conduits carrying data packets
  between linked facilities, an outer deck grid, a rim light chase, drifting
  haze and two sweeping searchlights. Scroll-wheel zoom (0.8x to 2.2x),
  drag-empty-ground pan with clamped bounds, and a RECENTER button. Pure
  helpers in `src/renderer/src/game/bay-environment.ts` (19 tests).
- **Deploy cinematics.** Target-lock reticle on the destination facility,
  dashed route line for every walk, teal data link with packets while
  working, success shockwave and sparks, red failure ring. All respect the
  in-app reduced-motion setting.
- **Real diff viewer.** Click a file in the Mission Debrief to see its
  unified diff inline (`DiffViewer.tsx`, new `DIFF_FILE_GET` IPC,
  `src/shared/diff-parse.ts`). Untracked files are now counted per file
  (`status -uall`) with real line counts. Reads are allowlisted to the
  deployment's own `diffFiles`, and symlinks (file or parent directory)
  can never be followed out of the repo.
- **Pilot ranks and mission alerts.** Service record per mech derived from
  deployment history (six ranks, Recruit to Ace) on crew cards and the
  companion panel. Desktop notifications, taskbar flash and an
  indeterminate taskbar progress bar while unfocused, with a Settings
  toggle (`src/main/mission-alerts.ts`).
- **Release pipeline.** `.github/workflows/release.yml` builds Windows,
  macOS (arm64 + x64) and Linux installers on `v*` tags into a draft
  GitHub Release. CI now also runs a production build. Issue and PR
  templates, SECURITY.md, Dependabot. Social preview card at
  `docs/social-preview.png` (also the site's og:image).

### Fixed

- Cloudflare site deploys from `main` failed since 2026-09-16: Cloudflare's
  builder moved to Node 24 + npm 12, whose `npm ci` requires optional peer
  dependencies in the lockfile, and ours was missing
  `@electron/windows-sign` and six transitive entries. Root cause verified
  by reproducing the exact `Missing:` errors with Node 24.18 + npm 12.1.0.
  Lockfile regenerated with npm 12 (`--package-lock-only`): 7 entries added,
  0 removed, 0 version changes; `npm ci` verified on npm 10, 11 and 12.
- Packaged builds: Kimi's Python wrapper is asarUnpacked and resolved from
  `app.asar.unpacked` (python cannot read inside app.asar).
- Packaged builds: renderer-only packages (phaser, mitt, fonts) moved to
  devDependencies and source art excluded, so they are no longer shipped
  twice inside app.asar.
- Mission alerts are constructed after the zombie sweep so crash-recovered
  missions don't fire "mech is down" notifications on boot.
- Diff viewer: a file deleted together with its whole directory is still
  viewable (realpath containment now walks up to the nearest existing
  ancestor). Regression test in `test/unit/git-diff.test.ts`.
- Bay apron no longer paints an opaque fill that exposed the Scale.FIT
  letterbox as a hard black box around the canvas.
- Crew card stat line no longer collides with the READY badge.
- SettingsModal: toggles resync from props during render instead of in
  effects, and the secrets-status load is cancellation-safe; clears all
  `react-hooks/set-state-in-effect` errors.
- macOS DMG artifact name includes `${arch}`, so arm64 and x64 builds no
  longer overwrite each other.

### Findings (no fix required)

- Verified the full mission loop in the real built app (demo mode, isolated
  profile) with a per-second timeline capture: route line and reticle
  appear during walks and fade on arrival; zero console errors.

### Earlier unreleased work

### Added

- **Landing page: `site/index.html`.** A self-contained static page (inline
  CSS, no external dependencies) in the app's HUD language: amber wordmark
  hero over the live `demo.gif` in a corner-bracketed bezel, mission-protocol
  steps, a mech roster using the real pixel-art sprites (downscaled to
  `site/mech-*.png`), a soul-layer terminal mirroring the actual demo
  mission's `memory.md`, architecture grid, and a copy-button quickstart.
  Built by Codex, then design-audited cross-family (Claude + Codex, final
  score 3.1/5 pre-fix) with the two highest-impact findings applied: real
  sprite art replacing generic icons, and tightened section rhythm. Deployed
  via git-connected Cloudflare Workers static assets: `wrangler.jsonc`
  points the CI deploy (`npx wrangler deploy`) at `site/`, no build step.
- **One-command demo gif: `npm run capture:demo`.** A Playwright script
  launches the built app in demo mode, drives the full shot list from
  `docs/gif-script.md` with an animated on-screen cursor (boot splash → drag
  Atlas-Prime onto the Research Lab → quick-prompt deploy → LIVE LOG
  streaming → Mission Debrief → tagline outro), captures frames, and
  assembles `docs/demo.gif` via two-pass palette ffmpeg encoding with
  automatic size fallbacks. Closes OSS-002: the README now opens with a
  real recording instead of a static screenshot, and the gif can be
  regenerated after any visual change. Includes a demo-gated layout hook
  that publishes mech/facility page coordinates (Phaser world → canvas →
  page), with the Scale.FIT letterbox math unit-tested. Windows
  fractional-DPI frame rounding is tolerated (±4px) since encoding rescales
  every frame.
- **Cinematic boot sequence + CRT overlay.** The bay now opens with a ~2.2s
  MECHBAY OS boot splash: subsystem check lines typing out under a scanline
  sweep, click or keypress to skip, reduced to a brief static card when the
  in-app motion preference is off. A subtle CRT layer (scanlines + vignette,
  pure CSS, zero input interference) sits over the whole screen like cockpit
  glass; toggle it in ⚙ SETTINGS ("CRT OVERLAY", persisted, default on).
- **Demo mode: the full deploy loop with zero API keys.** `npm run demo`
  (or launching with `MECHBAY_DEMO=1` / `--demo`) boots the bay with a
  built-in SimRunner behind every mech: it streams a per-mech-flavored
  scripted mission log AND makes real file edits in a seeded, git-initialized
  demo facility ("Reactor Control", created under userData), so the Mission
  Debrief shows a genuine git diff (nothing downstream of the runner is
  mocked). Demo mode persists to a separate `mechbay-state-demo` store so it
  never touches the real bay, and the HUD shows a `◈ SIMULATION` badge.
  Raven's sim script emits `▸ INTENT:` / `◆ FINDINGS:` lines, and the
  narration parser now accepts that glyph syntax alongside the existing
  `[INTENT]` form.

### Fixed

- **Deployed mechs can't hide behind buildings anymore.** A mech's render
  depth was set once at creation from its _home_ tile, so walking south past
  a facility left it sorted behind the building: invisible and, because
  Phaser routes clicks to the topmost sprite, unclickable while working or
  dead-in-field. Depth is now re-derived from the mech's feet on every
  movement (walk, drag, snap-back), mechs always sort in front of the
  facility they're standing at, and deployed mechs now park one tile south
  of the building (at the entrance, not on the roof), so both the mech and
  the building stay visible and clickable.
- **Mechs animate their walk cycle again (legs move, not just a glide).** The
  bay derived its "reduce motion" state from the OS `prefers-reduced-motion`
  setting, which Windows reports as _reduce_ whenever animation effects are
  turned off, a very common config for people who very much want to watch
  their mechs march. That single flag was suppressing the walk-frame swap,
  walk bob, idle breathing, foot dust, and beacon blinks all at once, so
  deploys read as a silent glide. Motion is now driven by an in-app
  preference that **defaults to full motion** and ignores the OS setting.
- **The bay renders sharp on 4K / maximized windows.** The Phaser canvas was
  rendering at a fixed 1100×640 internal resolution, which `Scale.FIT` then
  CSS-upscaled ~3× to fill a maximized 4K window, turning building labels and
  sprites to mush. The game is now created at the window's true device-pixel
  resolution (displayed width × devicePixelRatio, capped at 4×), and the scene
  scales the camera zoom by the same factor so the world framing is identical,
  just crisp. A debounced `ResizeObserver` re-renders at native resolution when
  the window is resized or maximized; `BayScene` re-centers on each Phaser
  RESIZE event, so no camera drift is introduced.

### Added

- **MOTION toggle in MECH SETTINGS.** A `MOTION: FULL / REDUCED` switch (full
  by default) lets anyone who wants a calm, still bay opt into reduced motion:
  the accessibility escape hatch, now user-controlled instead of silently
  inherited from the OS. Persists across restarts and applies live.
- **Single-instance lock.** Launching MechBay while it's already open now
  focuses the existing window instead of starting a second process. Prevents
  two instances from clobbering the same saved-state file, and silences the
  harmless Chromium "Unable to move the cache" GPU-cache boot error.

### Changed

- **Open-source pre-flight (OSS readiness audit).** Tagline reworded to
  "A BattleTech-inspired command bay for AI coding agents" with a
  non-affiliation note in the README (trademark hygiene); GitHub Actions CI
  added (typecheck + full test suite on every push/PR) with a README badge;
  repo description and topics filled; `npm audit` zeroed across the whole
  tree (fast-uri fix + vitest 2→4 major bump, both bump gates verified).
- **Mechs walk with weight.** Deploy walks used a fixed 1500 ms duration
  regardless of distance, so long treks across the bay looked like a sprint.
  Mechs now move at a constant ground speed (130 world px/sec, clamped
  1.4–5.2 s) so every walk reads as the same deliberate, heavy trudge.

## v1.3.0 - 2026-07-17

### Added

- **MECH SETTINGS centralizes callsigns, runtime loadouts, and credentials.**
  Rename any mech, reassign its runtime/model, and optionally store API keys
  encrypted through Electron safeStorage (Windows DPAPI on Windows). Stored
  keys are decrypted only in the main process and injected into that mech's
  deployment process at launch.
- **Right-click a building to decommission it.** MechBay removes the building
  from the bay while leaving its project directory and deployment history
  untouched. Buildings with active or queued deployments are protected.
- **Factory-reset the field.** Restore the six unlinked starter buildings
  with their original tiles and fresh IDs from the MECH SETTINGS bay controls.

### Fixed

- **Facility labels no longer leak after removal.** Phaser now tracks and
  destroys each building's name label alongside its sprite, beacon, and work
  light.

## v1.2.3 - 2026-07-17

### Fixed

- **The walk animation now survives coalesced state updates: the real
  "mechs still don't walk" fix.** v1.2.2 made the walk fire when the
  renderer observed a deployment in `walking-to`, but that status lives for
  under a millisecond in the main process (it flips to `working` in the
  same tick), and React batches rapid state broadcasts, so in the normal
  drag → modal → deploy flow the renderer's _first sighting_ of a
  deployment is already `working`, and the walk was silently skipped.
  Confirmed by instrumenting the scene: the `walking-to` snapshot never
  arrived. The transition differ now also fires the walk when a deployment
  first appears as `working` (or jumps `queued` → `working`), before the
  work sway, which already waits for arrival. Verified end-to-end through
  a real mouse drag + deploy modal against a heavy production state file.

## v1.2.2 - 2026-07-17

### Fixed

- **Bulk-imported facilities no longer stack on one tile.** The occupancy map
  now survives across the full import batch instead of being rebuilt from the
  same stale state before every project. On startup, MechBay also repairs
  existing schema-v2 saves with stacked facilities: the first building keeps
  its tile and later collisions move to the first free space on the 16×16 bay.
- **Mechs now walk when a deployment starts.** New deployments are born in
  `walking-to`, but the animation transition differ skipped records it had not
  seen in the previous state, so the first walk event could never fire. A pure,
  tested transition differ now handles brand-new deployments, and BayScene
  tracks active walks so working waits for arrival and failures stop in place.

### Added

- **Click an unlinked building to connect its project directory.** The six
  preset facilities now open a folder picker on first click, then open that
  project's files on later clicks. The unlinked-deploy guard now points players
  to this flow as well as BULK IMPORT.

## v1.2.1 - 2026-07-17

### Fixed

- **Codex/Gemini mechs died instantly on deploy (Windows).** `codex` and
  `gemini` exist on Windows only as npm `.cmd` shims, which
  `child_process.spawn` cannot launch with `shell: false`: every deploy
  ENOENT'd in ~200ms, flipping the mech straight to dead-in-field (the
  "gray + smoke right after drag" report). The availability probe uses
  `where.exe`, which _does_ find shims, so the mechs looked DEPLOYABLE.
  Runners now spawn via `cross-spawn` (resolves shims, handles escaping,
  keeps `shell: false`) and deliver the prompt through **stdin**
  (`claude -p`, `codex exec -`, piped `gemini`) instead of argv, which
  also removes the Windows ~32k argv ceiling risk for large
  soul + memory + task prompts. Root cause: verified against Node's
  shim-spawn behavior and reproduced live; first-ever successful Codex
  deployment on Windows confirmed end-to-end (agent created a file in a
  linked facility, exit 0).
- **Deploys to unlinked facilities are now rejected.** The six default
  facilities are seeded with no project folder; deploying into one ran the
  CLI in whatever cwd the app inherited. `deploy:start` now rejects with a
  message saying the facility isn't linked to a project folder yet and
  pointing to BULK IMPORT, which the renderer surfaces as an alert.

## v1.2.0 - 2026-07-17

### Added

- **Real walk-cycle sprite frames.** Every mech now plays a 4-frame walk
  animation (contact / passing / contact-mirrored / passing-mirrored) while
  moving, replacing the glide of a static sprite. Frames were generated
  from each mech's original sprite via Gemini image generation (reference
  image + magenta background), chroma-keyed, blob-segmented, bottom-center
  aligned, and packed into 1024×256 sheets at `assets/mechs/walk/`.
  BayScene drives frames from the walk tween's own onUpdate
  (`computeWalkFrame`, ~8 fps) so frame progress and position can't drift;
  on arrival the sprite reverts to its idle texture. Texture swaps re-run
  `setDisplaySize` + re-capture `baseScaleY` (same bug class as the v1.1
  absolute-scale stretch, handled explicitly). Falls back to the gliding
  idle sprite if a sheet fails to load, and skips frame animation under
  `prefers-reduced-motion`.
- **Automation hook.** The BayScene instance is exposed as
  `window.__mechbayScene` so Playwright-Electron smoke scripts can drive
  the scene (e.g. `walkTo`) instead of pixel-hunting the canvas.

### Notes

- Verified live: all 5 sheets load (4 frames each), frame index advances
  during a scripted walk, display height stays 96px across texture swaps,
  and the arrival squash uses the re-captured base scale.

## v1.1.0 - 2026-07-17

### Added

- **Any mech, any runtime (bring your own key).** Every companion now has a
  RUNTIME section in its stats panel: reassign the mech to any of the five
  runtimes (Claude Code / Codex / Gemini CLI / Kimi-Fireworks / custom CLI)
  and optionally set a model override, applied via each CLI's native flag
  (`--model` / `-m` / `-m` / `--model` / `{MODEL}` placeholder for
  `MECHBAY_HERMES_CMD`). Availability, deploys, and the NOT DEPLOYABLE badge
  all follow the assigned runtime. Auth stays with each CLI's own login/env;
  MechBay never stores keys. New `mechbay:companion:configure` IPC channel.
- **RTS game-feel pass.** Procedural animation, no sprite sheets: mechs face
  their direction of travel, bob and sway while walking with foot-dust puffs,
  land with a dust burst + squash, and "breathe" at idle with desynced phase.
  Selected mechs get a pulsing cyan iso selection ring that follows them.
  Working mechs sway ("servos active") while the target facility pulses an
  amber work light; every facility carries a staggered blinking beacon.
  All of it honors `prefers-reduced-motion`. Pure math lives in
  `bay-animation.ts` with unit tests.
- **Real app icon.** The taskbar/installer icon is now the Atlas mech on a
  dark HUD tile (replaces the stock Electron atom in
  `build/icon.{png,ico,icns}`).

### Fixed

- **Journal soul/memory read the wrong directory.** The SOUL_READ /
  SOUL_WRITE / MEMORY_READ handlers omitted the userData base dir, so
  soul-memory fell back to the home directory: the Journal showed
  "soul.md not found" and a Journal save would have written a copy that
  deployments never inject. Handlers now pass `app.getPath('userData')`,
  matching boot scaffolding. Root cause: verified against source
  (soul-memory.ts default parameter) and reproduced in the live app.
- **Scale animations were absolute, not relative.** The first cut of the
  animation pass tweened `scaleY` toward `1.0`, stretching every 96px-scaled
  mech ~10× vertically. All scale animations now derive from the sprite's
  captured base scale (`baseScaleY` helper). Caught by screenshot
  verification; gates alone missed it.

### Notes

- Cross-family review roster for this wave: Claude built, Fable audited
  (same-family). Codex was unavailable: its Windows sandbox cannot spawn
  processes (`CreateProcessAsUserW` error 5) and the unsandboxed fallback is
  not permitted in-session. See TODO for the follow-up.

## v1.0.0 - 2026-07-17

Feature-complete MVP, prepared for open-source release.

### Added

- **Mission Debrief.** After every deployment MechBay captures a git diff of
  the facility (baseline HEAD sha before spawn, `--numstat` + untracked files
  after exit), opens a MISSION DEBRIEF modal with task/duration/exit-code and a
  per-file `+ins/−del` table, floats a `✓ N files +X −Y` speech bubble over the
  returning mech, and writes the same summary into the mech's `memory.md`.
  Non-git facilities degrade to "diff unavailable"; git errors never fail a
  completed deploy.
- **Locust-Prime bring-your-own-agent runner.** Set `MECHBAY_HERMES_CMD` to
  any CLI command line (`{PROMPT}` substitution or stdin delivery) and the
  fifth mech becomes deployable with aider, goose, opencode, or your own
  scripts. Unset → honest `⚠ NOT DEPLOYABLE`.
- MIT `LICENSE`, `CONTRIBUTING.md`, repository metadata in `package.json`,
  hero screenshot at `docs/screenshot-bay.png`, this changelog.

### Changed

- **Raven-Prime availability is honest.** The probe now requires a
  discoverable `FIREWORKS_API_KEY` in addition to `python`, instead of
  lighting up deployable and failing at runtime with an auth error. The key
  came from the environment or from a fallback that read a local key file
  (removed in 1.4.1).
- README rewritten for a public audience (runtime table, quickstart,
  `MECHBAY_HERMES_CMD` examples); `HANDOFF.md` and `OVERNIGHT_REPORT.md`
  archived to `docs/history/`.
- Smoke-test checklist updated: Scenario 10 covers the custom runner,
  new Scenario 13 covers Mission Debrief.

### Fixed

- **Sprite backgrounds.** All 11 mech/facility sprites re-cut from pristine
  originals with AI background removal (rembg isnet + alpha solidify),
  replacing the partial chromakey pass that left checkerboard remnants. The
  ground tile's painted checker corners cleared via a feathered diamond mask.
  The bay now renders a continuous concrete floor with clean sprite
  silhouettes.

### Development history

Waves 1–6 (2026-04-17→18) built the Electron/Phaser MVP; Wave 7 added
chromakey, Journal, and Bulk Import; Wave 8 polished the app shell; the
chain-of-thought narration feature landed 2026-04-19. See
`docs/engineering/decisions.md` for the curated decision log.
