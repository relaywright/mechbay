# Security Policy

## Reporting a vulnerability

Please report security issues privately using GitHub's private vulnerability reporting: open the repo's Security tab and click "Report a vulnerability" (or go to https://github.com/relaywright/mechbay/security/advisories/new). Don't open a public issue for anything you believe is exploitable.

We'll acknowledge reports as soon as we can and follow up with next steps.

## Scope

Things we consider in scope:

- The IPC surface between the renderer and main process (`src/shared/ipc-channels.ts` and the handlers in `src/main/`)
- The filesystem reader's directory whitelist (what paths MechBay is allowed to read from and write to)
- Secrets storage, which uses Electron's `safeStorage` API
- The spawned agent CLI processes MechBay launches (Claude Code, Codex, Gemini CLI, Kimi via Fireworks, custom CLIs)

## A note on how MechBay runs agents

By design, MechBay runs agent CLIs with the same permissions as the user running MechBay. It does not sandbox agent processes beyond what the OS and the underlying CLI already provide. If you're pointing MechBay at a project directory, treat it the same way you'd treat running that agent CLI yourself in a terminal: the agent can read and write anywhere your user account can.
