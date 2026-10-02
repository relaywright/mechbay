# Release checklist

Run this for every tagged release. The goal is zero claim drift: every public statement matches the code that ships.

## Gates

1. `npm run typecheck` (app and tests), `npm run lint -- --max-warnings 0`, `npm test`, `npm run build` all pass locally on Windows.
2. A fresh clone outside your projects folder passes the same gates (a parent `node_modules` can hide a missing dependency).
3. The Verify workflow is green on the release commit; the release workflow cannot publish without it.
4. `node --experimental-strip-types scripts/smoke-electron.ts --demo` and the same without `--demo` both exit 0.
5. Real runtimes (the README promises this check): in a fresh profile, deploy Atlas-Prime (Claude Code) and Marauder-Prime (Codex) into a scratch git folder. Each finishes and returns a Mission Debrief with the expected diff.

## Public claims and their source of truth

| Claim                                     | Appears in                                       | Source of truth                                   | Check                                                               |
| ----------------------------------------- | ------------------------------------------------ | ------------------------------------------------- | ------------------------------------------------------------------- |
| App version                               | Boot splash, release title                       | `package.json` `version`                          | Injected at build time; never typed by hand                         |
| Test count                                | Nowhere                                          | Not published                                     | `test/unit/public-claims.test.ts` fails on a hand-typed count       |
| Runtime support and "not verified" labels | README mechs table, landing roster, in-app panel | `src/shared/runtime-support.ts`                   | `public-claims.test.ts`, `runtime-support.test.ts`                  |
| Demo facility name                        | README demo section, landing memory example      | `src/main/demo-mode.ts` (`reactor-control`)       | `public-claims.test.ts`                                             |
| Simulation label                          | README, HUD                                      | `HudHeader.tsx` (`SIMULATION ONLINE`)             | Read both before release                                            |
| Concurrency and queue                     | README, landing tech panel                       | Main-process deployment queue                     | No order claim until queue order is fixed                           |
| "Approve"                                 | Nowhere yet                                      | Approve controls (P1-08 web, P2-08 real missions) | `public-claims.test.ts`                                             |
| Landing URL and link previews             | Portfolio card, README, `og:` tags               | `https://mechbay.samalbanese.com/`                | `landing-page.test.ts`; paste the URL into a link-preview validator |
| Portfolio card copy                       | samalbanese.com                                  | Portfolio site source (separate repo)             | Read it against this table                                          |

## Publish

1. Bump `package.json` with `npm version <x.y.z> --no-git-tag-version`; update `CHANGELOG.md`.
2. Merge the release pull request, tag `vX.Y.Z` on `main`, push the tag.
3. The release workflow builds a draft. Read the draft notes, then publish.
4. Refresh the demo media and write one short public post about the release.
