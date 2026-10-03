# Portfolio refresh: September 16, 2026

## Original intent

Agents should feel like persistent companions, not anonymous buttons. A mech represents a runtime, a facility represents a project directory, and deployment bridges the game world to actual work. The experience must show the whole loop: choose, deploy, observe, review, remember.

## What changed

- New command deck, self-hosted typography, clearer hierarchy, field framing, and visible five-mech roster.
- Operations panel with keyboard-accessible mission preparation, availability state, live counts, recent missions, and project browsing/linking.
- Completed missions can reopen their debrief. File totals and the limits of working-tree capture are visible.
- Deployment errors keep the typed prompt. Live output opens automatically after starting a mission.
- Runtime selection, model overrides, persistent journals, project import, settings, and the existing runner integrations remain available.
- Canvas resizing is refreshed against the parent dimensions to prevent clipping after fonts load or the window changes size.
- Portfolio video, poster, three inspectable screenshots, and MechBay landing-page media use the refreshed app.

## Reproduce captures

Requires Node 22.18+ (or another version supporting TypeScript stripping), git, ffmpeg/ffprobe, and the repository dependencies.

```powershell
npm run capture:portfolio
node --experimental-strip-types scripts/export-portfolio.ts --portfolio <portfolio site checkout>
```

The first command builds, runs the real app in an isolated simulation profile, verifies a mission and its file-change report, captures 1600×1000 screenshots, and encodes the project media. The second copies the verified media into the portfolio checkout. It does not deploy either site.

Raw screenshots, verification evidence, and frame sequences are in ignored `artifacts/portfolio`. Generated public media includes a capture manifest with date, simulation provenance, dimensions, video size, and playback speed. MP4 and WebM are each capped at 700 KiB. The demo GIF is capped at 15 MiB.

## Verification record

- On 2026-09-16 the full suite passed (305 tests across 42 suites). The initial concurrent test/capture run exposed timing-sensitive test failures; the full suite passed with capture finished.
- Electron production build and type checks passed. The updated command components, operations helpers, and capture/export utilities passed a scoped lint check.
- The recorded app completed a simulation mission with two actual changed files. Opening the resulting debrief again, changing crew, opening Journal, browsing a linked project, and resizing to a laptop window were verified without renderer errors.
- The consulting site reported zero errors, warnings, or hints and built successfully.
- Both sites passed overflow and media checks at 320, 390, 768, 1024, and 1440px. The portfolio gallery also works without JavaScript. Desktop and phone screenshots are in the portfolio checkout's `output/mechbay-refresh` directory.
- MP4: 608,548 bytes. WebM: 420,214 bytes. Both are 24-second recordings; screenshots are 1600×1000.

## Browser playback correction

The initial export inherited full-range color from the JPEG capture frames. It decoded in headless Chromium but failed in the Windows in-app browser. Converting the pixels to limited-range 8-bit YUV 4:2:0 fixed playback in that same browser. Both H.264 and VP9 exports now use this conversion, omit the capture image's ICC side data, and pass an ffprobe encoding check before publication. The video URLs have a new version to bypass cached broken files.

`node --experimental-strip-types scripts/verify-video.ts [portfolio-url]` checks both formats through the last frame at desktop and phone widths. Metadata loading or a single decoded frame is insufficient verification for this failure. Playback evidence and screenshots are saved in ignored `artifacts/video-compat`.

## Scope limits

This pass verifies the simulation lifecycle and existing automated runner tests. It does not certify live third-party agent credentials or submit real coding tasks. Existing dirty-tree changes can be part of a debrief; isolated worktrees are still a separate feature. No public deployment is performed by the capture commands.
