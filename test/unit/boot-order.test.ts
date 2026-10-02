import { readFileSync } from 'fs'
import path from 'path'
import { describe, expect, it } from 'vitest'

// Upgrading a v1.4.0 save moves its logs out of the saved file; they reach
// the log files only when prepareLogStore runs. Anything that can throw in
// between ends boot with the logs only in the backup and, on the next
// launch, no notice. index.ts has no end-to-end boot test, so this guards
// the order in the source.
const INDEX = readFileSync(path.resolve(__dirname, '../../src/main/index.ts'), 'utf8')

function at(snippet: string): number {
  const index = INDEX.indexOf(snippet)
  expect(index, `${snippet} not found in src/main/index.ts`).toBeGreaterThan(-1)
  return index
}

describe('boot order', () => {
  it('opens the secrets file, which throws when damaged, before upgrading the saved bay', () => {
    expect(at("new Store({ name: 'mechbay-secrets' })")).toBeLessThan(at('new StateManager('))
  })

  it('imports old logs straight after upgrading the saved bay', () => {
    const between = INDEX.slice(at('new StateManager('), at('prepareLogStore(logs, state'))
    // Disk work that can throw outside a try/catch belongs after the import.
    for (const risky of [
      'seedDemoWorkspace(',
      'linkDemoFacility(',
      'scaffoldSoulAndMemory(',
      'new FsReader(',
      'dirname(',
      'registerIpc('
    ]) {
      expect(between, `${risky} runs between the upgrade and the log import`).not.toContain(risky)
    }
  })
})
