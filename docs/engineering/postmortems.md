# Post-mortems

Five bugs worth learning from, each written as symptom, root cause, fix and
guard (the test or check that stops a repeat). "Root cause (verified)" means
the cause was confirmed against source, a reproduction or runtime probes at
the time. Where it was not, the entry says so.

---

## Mechs never walked (v1.2.2 and v1.2.3, 2026-07-17)

**Symptom:** Dragging a mech onto a building started the mission, but the
mech never walked there. Failure smoke and the working animation still
fired, so the bay looked mostly alive. The walk had only ever run when smoke
scripts called `walkTo` directly, never through a real deploy, and every gate
stayed green for three releases.

**Root cause (verified):** Two layers.

1. The scene's transition logic skipped any deployment it had not seen in
   the previous state snapshot. Deployments are created in `walking-to`, so
   the first edge, the one that starts the walk, could never fire.
2. After that fix, the walk still did not fire in the normal drag, modal and
   deploy flow. `walking-to` lives for under a millisecond in the main
   process before it becomes `working` in the same tick, and React batches
   rapid state broadcasts, so the renderer's first sighting of a new
   deployment was already `working`. Wrapping the scene's state setter in a
   live session confirmed the `walking-to` snapshot never arrived. An earlier
   end-to-end check had passed only because it called IPC directly from an
   idle renderer and skipped the modal.

**Fix:** The status diff moved into a pure module,
`src/renderer/src/game/deployment-transitions.ts`, which treats "not seen
before" as a transition and fires the walk when a deployment first appears
as `working` or jumps from `queued` to `working`. The scene only maps the
resulting actions to effects. The rule we adopted: renderer animations key
off durable state, never off seeing a status that the main process sets and
overwrites in the same tick.

**Guard:** `test/unit/deployment-transitions.test.ts`, including "walks a
brand-new walking-to deployment", "still walks when the first observed
snapshot is already working" and "still walks when queued jumps straight to
working". Pulling the logic out of the Phaser scene is what made the edge
testable at all.

---

## Codex and Gemini mechs died on deploy (Windows, v1.2.1, 2026-07-17)

**Symptom:** On Windows, a Codex or Gemini mech showed as deployable, then
went gray and smoking (dead in the field) about 200 ms after it was dragged
onto a building. Every non-Claude deployment since April had failed this
way.

**Root cause (verified):** npm installs `codex` and `gemini` on Windows as
`.cmd` shims with no `.exe`. Node's `spawn(cmd, args, { shell: false })`
cannot launch a `.cmd` file (Node hardened this after CVE-2024-27980), so
each spawn failed at once with ENOENT and exit code -1. The availability
check used `where.exe`, which does find shims, so the check and the spawn
disagreed about what "available" meant. Claude worked only because it ships
a real `.exe`. The error text, `[spawn error] spawn gemini ENOENT`, was
sitting in the deployment's saved log the whole time.

**Fix:** `CliRunner` spawns through `cross-spawn`, which resolves shims and
escapes arguments while keeping `shell: false`. All CLI runners also moved
the prompt from argv to stdin. Verified end to end through the built app: a
Codex mech deployed to a linked folder, created a file and exited 0, the
first successful Codex deployment on Windows.

**Guard:** `test/unit/runners-cli-matrix.test.ts` pins the argv each runner
passes, checks that the shared `CliRunner` spawns with the shell disabled,
and checks that every runner reports ENOENT with exit code -1 instead of
hanging. The tests inject a fake spawn function, so they pin the contract,
not Windows shim resolution itself. The diagnostic signature is worth
remembering: exit code -1 about 200 ms after start means the process never
launched, and the reason is in the saved log chunks.

---

## The bay turned into a green hexagon pattern (2026-04)

**Symptom:** Instead of concrete, mechs and buildings, the bay showed a
green hexagonal pattern tiled across the whole scene.

**Root cause:** The Content-Security-Policy in `src/renderer/index.html` left
`blob:` out of `img-src`. Phaser loads images with XHR and turns them into
`blob:` URLs with `createObjectURL`, so the policy blocked every image.
Phaser then fell back to its built-in `__DEFAULT` texture, a small green
placeholder, and tiled it. The project notes record CSP violations in
DevTools as the tell; no standalone reproduction was kept.

**Fix:** `img-src 'self' data: blob:` in the renderer's CSP.

**Guard:** A `loaderror` listener in `BayScene.preload()` logs every asset
that fails to load, so this class of bug announces itself instead of
showing up as strange art. No automated test pins the CSP yet.

---

## The world slowly drifted upward (2026-04-17)

**Symptom:** The bay canvas slowly scrolled upward while the HUD around it
stayed still. Nothing in the code moved the camera.

**Root cause:** As diagnosed in the session debrief (no isolated reproduction
was recorded): the game used `Phaser.Scale.RESIZE`, which keeps resizing the
canvas to match its parent element, but the scene centered the camera only
once, in `create()`. Every parent reflow (a React re-render, the log panel
growing, a scrollbar appearing or disappearing) moved the viewport while the
camera kept its old center.

**Fix:** `Phaser.Scale.FIT` with `autoCenter: CENTER_BOTH`, which letterboxes
the world proportionally so parent reflows cannot move it. When device-pixel
rendering arrived later, the scene also re-centers the camera on every
Phaser resize event.

**Guard:** No automated test. The project notes forbid `Scale.RESIZE` unless
the scene also re-centers on every resize, and the camera transform is
re-applied on each resize event.

---

## Facility labels were blurry on 4K screens (v1.4.1)

**Symptom:** On a maximized 4K window, building name labels looked soft,
even after the canvas began rendering at the window's device-pixel
resolution.

**Root cause:** Phaser draws each text label into its own small canvas at
a fixed resolution (1 by default), and the camera then scales that texture
by its zoom. On a maximized 4K window the measured camera zoom was 2.09, so
each label texel was stretched across about two screen pixels. Confirmed
in Phaser 3.90's source (the WebGL text renderer divides by the style's
resolution) and by an isolated before and after: changing only the label
resolution removed the blur.

**Fix:** A helper, `textResolutionForZoom(zoom)` in
`src/renderer/src/game/text-resolution.ts`, picks a text resolution that
matches the camera zoom, clamped between 0.5 and 6 and rounded up to 0.05
steps, so labels are never coarser than the screen and tiny zoom changes do
not redraw every label. The scene applies it to every facility label and
NOT DEPLOYABLE label whenever the camera zoom changes, and new labels start
at the current zoom's resolution.

**Guard:** `test/unit/text-resolution.test.ts` checks that labels never
render below screen resolution anywhere in the bay's zoom range, that the
largest allowed camera zoom is covered, that a maximized 4K window renders
labels at about 2x instead of 1x, and that invalid zooms fall back safely.
Before and after screenshots at 1x and 4K show sharp edges where the
blur was, and a pixel diff that touches only the label boxes.
