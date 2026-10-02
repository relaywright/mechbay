import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { assembleSystemPrompt, extractTaskPrompt } from '../../src/main/soul-memory'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Builds a prompt exactly the way a deployment does, so a format change breaks this test. */
function assembled(task: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'mechbay-task-'))
  dirs.push(dir)
  const soulPath = join(dir, 'soul.md')
  const memoryPath = join(dir, 'memory.md')
  writeFileSync(soulPath, 'I am Atlas. I hold the line.\n')
  writeFileSync(memoryPath, '## 2026-09-30 12:00 · reactor-control · "calibrate"\nDone.\n')
  return assembleSystemPrompt('Atlas-Prime', { soulPath, memoryPath }, task)
}

describe('extractTaskPrompt', () => {
  it('returns exactly the task from an assembled prompt', () => {
    expect(extractTaskPrompt(assembled('Refactor the telemetry module.'))).toBe(
      'Refactor the telemetry module.'
    )
  })

  it('keeps a multi-line task whole', () => {
    const task = 'Fix the build.\n\n1. Run the tests.\n2. Report back.'
    expect(extractTaskPrompt(assembled(task))).toBe(task)
  })

  it('keeps a task that itself contains the "# Current Task" heading', () => {
    const task = 'Rename the section.\n\n---\n\n# Current Task\n\nshould become # Mission'
    expect(extractTaskPrompt(assembled(task))).toBe(task)
  })

  it('returns a prompt without a soul preamble as is', () => {
    expect(extractTaskPrompt('  Survey the facility.  ')).toBe('Survey the facility.')
  })

  it('assembles prompts without em dashes', () => {
    expect(assembled('Check the logs.')).not.toContain('\u2014')
  })
})
