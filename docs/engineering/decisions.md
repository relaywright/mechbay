# Engineering decisions

A curated subset of the decisions behind MechBay, with the context, the
options we turned down, and what each choice cost or bought. Entries are
oldest first. Each one names the internal record it was taken from.

---

## 2026-04-17 · One `Runner` interface is the only boundary to agent runtimes

**Context:** MechBay drives five different agent CLIs (Claude Code, Codex,
Gemini CLI, a Kimi wrapper and a custom command). Each has its own flags,
output style and failure modes, and the bay, the logs and the Mission
Debrief should not care which one is running.

**Decision:** Every runtime implements one small contract in
`src/main/runners/types.ts`: `isAvailable()` and
`spawn(cwd, prompt, options)`, which returns a stream of stdout and stderr
chunks, an `abort()` function and an exit-code promise. One file per
runtime under `src/main/runners/`; adding a runtime means implementing
`Runner` and registering it in the runner map.

**Alternatives rejected:** No alternative was written down at the time.
The October 2026 roadmap review looked again and rejected a rewrite of the
stack because this boundary (with the typed IPC registry) had held up.

**Consequence:** Later features plugged in without changing the contract:
the bring-your-own-agent runner (`MECHBAY_HERMES_CMD`), per-mech runtime
and model overrides, and the demo mode `SimRunner`. The bring-your-own
runner's spec made "do not modify `types.ts`" an explicit constraint.

**Source:** internal design spec (2026-04-17), runner contract in
`src/main/runners/types.ts`, internal decision log (2026-07-17 and
2026-10-01 entries)

---

## 2026-04-17 · IPC channel names live in one typed registry

**Context:** Electron splits the app into a main process, a preload script
and a React renderer that talk over named IPC channels. A channel name
typed by hand in one of those places and spelled differently in another
breaks the link between them.

**Decision:** Every channel is declared once in `src/shared/ipc-channels.ts`
as `IPC.*`, named `mechbay:<domain>:<action>` so it is easy to grep. Code
never hand-types a channel name. New channels go into the registry first,
then the main-process handler, the preload bridge and the renderer. Types
that cross the boundary live in `src/shared/types.ts` and must be plain
serializable data (no class instances, functions, Maps or Sets). The
preload API is exposed as `window.mechbay`.

**Alternatives rejected:** The original plan named the preload API
`window.electronAPI`. We renamed it because the Electron template already
exposes `window.electron`, and two near-identical names invite mistakes.

**Consequence:** Adding a feature that needs the main process (secrets,
settings, the diff viewer, facility linking) follows the same four steps
every time, and reviewers can check a new channel against one file.

**Source:** internal design spec (2026-04-17), internal v1.5 polish spec
(2026-04-18), internal decision log (Wave 1 amendments), project agent notes

---

## 2026-04-17 · Render at device-pixel resolution with `Scale.FIT`

**Context:** The bay is a Phaser canvas inside a React layout. Phaser has to
decide how big to draw and how to follow its parent element when the window
or the layout changes.

**Decision:** Use `Phaser.Scale.FIT` with `autoCenter: CENTER_BOTH`, so
Phaser letterboxes the world proportionally and parent reflows never move
it. Create the game at the window's real device-pixel size (base framing
times a render scale clamped between 1 and 4), resize it through a debounced
`ResizeObserver`, and scale the camera zoom by the same factor so the
framing stays identical while the pixels get sharper. The scene re-centers
the camera on every Phaser resize event. (`Scale.FIT` came first; the
device-pixel rendering was added before v1.4.0.)

**Alternatives rejected:** `Phaser.Scale.RESIZE` with a camera centered once
in `create()`, which let the world drift whenever the layout reflowed (see
the post-mortems). A fixed 1100×640 render size, which `Scale.FIT` stretched
about 3× on a maximized 4K window and turned labels and sprites to mush.

**Consequence:** The world no longer drifts, and the canvas renders at
native resolution on large displays (text labels needed one more fix; see
the post-mortems). The base framing numbers are constants for the framing, not the render size;
pinning the render size back to 1100×640 would bring the 4K blur back.

**Source:** session debrief (2026-04-17, Wave 5), project agent notes,
changelog (v1.4.0)

---

## 2026-04-18 · Prompts go to agents through stdin, never argv

**Context:** A mission prompt is the mech's soul file, its memory file and
the user's task joined together, and can run to 10 to 20 KB of free text. Windows caps a command line at about 32k characters, and text
passed as arguments through cmd.exe needs quoting.

**Decision:** Every CLI runner writes the prompt to the child's stdin
(`claude -p`, `codex exec -`, piped `gemini`, and the Kimi wrapper's `-`
argument). The shared `CliRunner` base class has an optional
`stdinInput(prompt)` hook for this. Each CLI's stdin mode was checked live
before the switch.

**Alternatives rejected:** Passing the prompt as an argument (hits the
length ceiling and needs shell quoting). Writing the prompt to a temporary
file (the file leaks if a mission is aborted and needs cleanup code).

**Consequence:** Prompt size and content no longer depend on the platform's
command-line rules, and no prompt text is ever parsed by a shell.

**Source:** internal decision log (2026-04-18 Kimi runtime entry and
2026-07-17 Windows spawning entry)

---

## 2026-07-17 · `cross-spawn` launches Windows `.cmd` shims with `shell: false`

**Context:** On Windows, npm installs CLIs such as `codex` and `gemini` as
`.cmd` shims with no `.exe`. Node's `spawn` cannot launch a `.cmd` file
with `shell: false`, so every deploy to those mechs failed instantly.

**Decision:** `CliRunner` spawns through `cross-spawn`, which resolves the
shim and escapes arguments while keeping `shell: false`.

**Alternatives rejected:** `shell: true`. It would launch the shims, but it
hands the command line to cmd.exe, which would then parse arbitrary prompt
text. The decision log says never to flip it.

**Consequence:** The first successful Codex deployment on Windows ran after
this change. A unit test pins that the runner spawns with the shell
disabled.

**Source:** internal decision log (2026-07-17, Windows CLI spawning),
changelog (v1.2.1)

---

## 2026-07-17 · Mission Debrief diffs against the pre-deploy commit, and fails open

**Context:** After a mission, the player should see what the agent changed
without leaving the bay.

**Decision:** Before each deploy, MechBay records the facility's `HEAD`
commit. After the agent exits, it computes `git diff --numstat` against that
commit plus untracked files, and shows the result in the Mission Debrief and
in the mech's memory file. Every git call has a 5 second timeout and returns
nothing on error, so a git problem never turns a completed mission into a
failed one. Non-git folders show "diff unavailable".

**Alternatives rejected:** Isolating the agent's changes with stash-style
snapshots. Deferred.

**Consequence:** Changes the agent commits during the run still count. The
accepted limit: uncommitted changes that existed before the deploy are
credited to the mech.

**Source:** internal decision log (2026-07-17, Mission Debrief)

---

## 2026-07-17 · API keys are OS-encrypted and injected only into the mech's process

**Context:** The author wanted a way to set a key per runtime inside the app
("bring your own key"). Until then MechBay stored no credentials at all and
left auth to each CLI's own login or environment variables.

**Decision:** Keys are encrypted with Electron `safeStorage` (DPAPI on
Windows) in a separate secrets store, never in the main state file, so a
state export or backup cannot leak them. Three rules, each covered by
tests: decrypted values exist only in the main process, and no IPC channel
can return a key (the renderer only sees "set" or "not set"); a key is
injected only into the spawned mech process's environment at launch; the
Claude runtime never stores a key, because Claude Code signs in with its
own login. A corrupt or foreign-machine blob decrypts to nothing, and the
deploy falls back to environment-variable auth instead of failing.

**Alternatives rejected:** Plain text in the state store. `keytar`
(deprecated upstream; `safeStorage` is its maintained replacement). Calling
an OS keychain CLI (shells out and works poorly on Windows).

**Consequence:** The renderer can never display or leak a key, and a stored
key overrides an ambient environment variable because it is the player's
explicit in-app choice.

**Source:** internal decision log (2026-07-17, v1.3.0)

---

## 2026-07-17 · Bay motion is an in-app setting, not the OS reduced-motion flag

**Context:** The bay switched off all animation when the OS reported
`prefers-reduced-motion: reduce`. Windows reports that whenever "Animation
effects" is off, a common performance tweak, so on those machines the walk
cycle, walk bob, idle breathing, foot dust and beacon blinks all vanished
and every deploy read as a silent glide. A boot probe confirmed the flag
was on while every walk sheet had loaded.

**Decision:** Motion follows a saved in-app preference that defaults to
full motion. A `MOTION: FULL / REDUCED` toggle in Mech Settings is the
player's accessibility control, and the scene applies a change live without
a reload.

**Alternatives rejected:** Keeping the OS flag as an absolute override. In
a desktop app whose point is watching mechs move, it maps poorly to what
the player wants, and it muted feedback motion (the walk means
"deploying"), not just decoration.

**Consequence:** The general rule we took away: treat the OS setting as an
input to a default, let it mute only decorative motion, and always pair it
with an in-app control.

**Source:** internal decision log (2026-07-17, v1.3.x), changelog

---

## 2026-07-18 · Demo mode swaps only the agent process

**Context:** Most people evaluating the repo do not have `claude` or
`codex` installed and signed in, so the main experience was locked behind API keys.

**Decision:** A built-in `SimRunner` implements the same `Runner` contract.
With `npm run demo` (or `MECHBAY_DEMO=1`, or `--demo`), it replaces the
runner for every mech. It streams a scripted, per-mech mission log and makes
real file edits in a seeded, git-initialized demo facility, so the Mission
Debrief shows a genuine git diff. Nothing downstream of the runner is mocked.
Demo mode saves to its own state store, so it never touches the real bay,
and the HUD shows a `◈ SIMULATION` badge.

**Alternatives rejected:** None written down. The spec's done criterion was
the full deploy, live log and real-diff debrief loop with zero external
dependencies, which rules out faking the later stages.

**Consequence:** The demo exercises the same state, animation, log and
debrief code as a real mission, so it doubles as an end-to-end check of
the built app. The project's honesty rule covers it: simulation is always
labeled.

**Source:** internal design spec (2026-07-18), changelog (v1.4.0)

---

## 2026-10-01 · Roadmap: reach, then proof, then spectacle

**Context:** v1.4.0 was the first public release with installers, but trying
it still meant cloning the repo, some public claims had drifted from the
code, and real Claude missions showed a blank log until the end, which
made the app hard to use for day-to-day work.

**Decision:** A phased roadmap, each phase shippable on its own. Phase 0
splits into Track A (v1.4.1: truth, funnel and hygiene) and Track B
(v1.4.2: state migrations, a readable Claude stream, queue order and other
foundations). Phase 1 (v1.5) puts the same renderer in the browser with an
operations-flavored demo and a deliberate "reject the bad output" moment.
Later phases add a real-fleet console, a reactive world and multi-runtime
teams. Two of the open questions it settled: publish a curated decision log
(this folder) and keep raw notes private; default mech autonomy is "Edit
files", and "Full" stays an explicit per-mech opt-in even after worktrees,
because a worktree isolates changes, not permissions.

**Alternatives rejected:** Competing as another agent orchestrator
(platform vendors now bundle parallel agents, and standalone orchestrators
are shutting down). A stack rewrite (the typed IPC registry and the
`Runner` boundary are sound; the problems are local).

**Consequence:** Truth comes first: every public claim gets a source, and
features wait until the data they persist can be migrated. A cross-family
adversarial review (Claude and Codex) of the first draft raised 18
findings, and all 18 were folded into the plan.

**Source:** internal decision log (2026-10-01), internal roadmap spec
(2026-10-01)

---

## 2026-10-02 · A mission's project is untrusted input, and the window is untrusted too

**Context:** MechBay launches AI agents into real project folders, then
reads those folders back to build the Mission Debrief. An agent that has
been misled (by a poisoned README, a malicious dependency or a hostile
issue) can write anything inside its project, including the project's own
`.git/config`. A security review found that four bridges between the bay
window and the main process trusted more than they should. Codex reviewed
the first three rounds of fixes; Claude reviewed the last two after Codex
hit its usage limit.

**Decision:** Two threats are in scope: a compromised bay window, and a
misled agent that can write anywhere inside its project but nowhere else.
Against them, each covered by tests:

- _The window cannot name places on disk._ The project scan always uses
  the folder from Settings. Bulk import accepts only folders that scan
  returned, compared by their real on-disk path. Journal reads and writes
  accept only the ID of a mech that exists, and the ID can never be a path.
- _Reading a project's git history does not run programs the project
  defines._ Every git call switches off fsmonitor, hooks, external diff and
  textconv helpers, and optional index writes. It runs with a clean git
  environment and a `GIT_ALLOW_PROTOCOL` list whose only entry, `0`, can
  never name a transport or remote helper, so git can start no network
  transport or helper program, and project config cannot widen the list.
  (An empty list is not enough: git reads `::x` as a helper with an empty
  name.) Submodules show only their commit pointer. Filter drivers that the
  project's own config defines are switched off, and so is Git LFS when the
  project's own config defines LFS extension commands. Before reading any file contents, MechBay
  checks the project's git settings; if they point git at a different
  working folder, or cannot be read safely, the debrief says the diff is
  unavailable and no file contents are read. The debrief says "No git
  repository" only when no `.git` exists in the project or any folder
  above it.
- _Known keys are hidden in what MechBay shows and saves._ Stored API keys,
  the runtime key variables, and any environment variable whose name says
  KEY, TOKEN, SECRET or PASSWORD are replaced with `[redacted]` in the live
  log, saved logs, failure and crash summaries, the mech's memory file and
  the saved task text. A key that spans several lines is hidden line by
  line. The Kimi wrapper's shell commands run without any runtime's API
  key.

**Alternatives rejected:** Switching off every filter driver, including the
player's own. Git LFS files would then show up as raw pointer files, which
makes their diffs misleading. Copying the repository to a sandbox before
diffing: too slow for large projects.

**Consequence:** Five risks remain, accepted on purpose and listed here so
nobody mistakes them for guarantees:

- _Reachable from inside a project, accepted:_
  - Filters in the player's own global or system git config still run,
    including Git LFS extension commands defined there. If such a filter
    executes something from the project folder, a misled agent can use it.
    That setup is the player's choice; MechBay trusts it.
  - A process the agent leaves running after the mission ends could change
    `.git/config` between the moment MechBay lists filters and the moment
    git runs. It needs a process left running in the project and a won
    race, which a process rewriting the file in a loop can eventually win.
  - Secrets that live in project files reach the agent's AI model and can
    appear in file names or diffs, as with every coding agent. MechBay only
    hides keys it knows.
  - Values shorter than 8 characters are never hidden, even under a
    secret-looking name, and neither are short lines of a multi-line key
    (such as a PEM's last line). Variables like `KEYBOARD_DELAY=1` would
    otherwise blank every "1" in the log. The reverse also happens: a
    secret-named variable that holds a file path, such as `SSH_KEY_PATH`,
    is hidden like a key. A key is recognized only exactly as stored: a
    tool that prints it base64-encoded or escaped is not caught.
- _Not reachable from inside a project:_ a folder link planted in the
  projects folder or in MechBay's data folder is followed. Planting one
  needs write access outside the project.

**Source:** internal Track A plan (2026-10-01, Task 5b), Codex and Claude
security reviews (2026-10-02)
