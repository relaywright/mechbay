import { renameSync } from 'fs'
import path from 'path'
import type { StoreLike } from './state-manager'

export interface OpenStateStoreDeps<S extends StoreLike> {
  /** Folder that holds the store file (electron-store's default: app.getPath('userData')). */
  dir: string
  /** Store name; the file is `<dir>/<name>.json`. */
  name: string
  /** Construct the store. electron-store throws a SyntaxError here when the file is not valid JSON. */
  createStore: (name: string) => S
  rename?: (from: string, to: string) => void
  now?: () => Date
}

/**
 * Open the saved-bay store without ever booting into an error screen. A
 * file that is not valid JSON (power loss mid-write, a bad hand edit) is
 * moved aside, never deleted, and a fresh store opens in its place. Any
 * other error is rethrown untouched.
 */
export function openStateStore<S extends StoreLike>(
  deps: OpenStateStoreDeps<S>
): { store: S; notice?: string } {
  try {
    return { store: deps.createStore(deps.name) }
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'SyntaxError') throw err
    const file = path.join(deps.dir, `${deps.name}.json`)
    const stamp = (deps.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-')
    const aside = path.join(deps.dir, `${deps.name}.corrupt-${stamp}.json`)
    ;(deps.rename ?? renameSync)(file, aside)
    console.error(`[state-store] ${file} is not valid JSON; moved it to ${aside}`)
    return {
      store: deps.createStore(deps.name),
      notice: `Your saved bay file was damaged, so MechBay started a fresh one. The damaged file was kept at ${aside}.`
    }
  }
}
