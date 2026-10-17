import { describe, expect, it } from 'vitest'
import { parseUnifiedDiff } from '../../src/shared/diff-parse'
import {
  missionPatchFileName,
  renderFilePatch,
  renderMissionPatch
} from '../../src/shared/patch-render'
import type { FilePatch } from '../../src/shared/types'

const MODIFIED: FilePatch = {
  path: 'src/app.ts',
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -1,3 +1,3 @@',
      lines: [
        { kind: 'ctx', text: 'line one', oldNo: 1, newNo: 1 },
        { kind: 'del', text: 'line two', oldNo: 2 },
        { kind: 'add', text: 'updated line', newNo: 2 },
        { kind: 'ctx', text: 'line three', oldNo: 3, newNo: 3 }
      ]
    }
  ]
}

const ADDED: FilePatch = {
  path: 'docs/new.md',
  binary: false,
  truncated: false,
  hunks: [
    {
      header: '@@ -0,0 +1,2 @@',
      lines: [
        { kind: 'add', text: '# New', newNo: 1 },
        { kind: 'add', text: '', newNo: 2 }
      ]
    }
  ]
}

describe('renderFilePatch', () => {
  it('writes a git-style section for a modified file', () => {
    expect(renderFilePatch(MODIFIED)).toBe(
      [
        'diff --git a/src/app.ts b/src/app.ts',
        '--- a/src/app.ts',
        '+++ b/src/app.ts',
        '@@ -1,3 +1,3 @@',
        ' line one',
        '-line two',
        '+updated line',
        ' line three',
        ''
      ].join('\n')
    )
  })

  it('marks a synthesized untracked-file patch as a new file from /dev/null', () => {
    const text = renderFilePatch(ADDED)
    expect(text).toContain('new file mode 100644\n--- /dev/null\n+++ b/docs/new.md\n')
    expect(text).toContain('+# New\n+\n')
  })

  it('round-trips through the parser', () => {
    expect(parseUnifiedDiff(renderFilePatch(MODIFIED))).toEqual(MODIFIED.hunks)
    expect(parseUnifiedDiff(renderFilePatch(ADDED))).toEqual(ADDED.hunks)
  })

  it('emits only the binary marker for a binary file and nothing for an unchanged one', () => {
    expect(renderFilePatch({ path: 'logo.png', binary: true, truncated: false, hunks: [] })).toBe(
      'diff --git a/logo.png b/logo.png\nBinary files a/logo.png and b/logo.png differ\n'
    )
    expect(renderFilePatch({ path: 'same.txt', binary: false, truncated: false, hunks: [] })).toBe(
      ''
    )
  })
})

describe('renderMissionPatch', () => {
  it('puts a plain-text preamble before the first diff header and lists every file', () => {
    const text = renderMissionPatch(
      {
        mech: 'Atlas-Prime',
        project: 'reactor-control',
        task: 'Tighten the\n  sensor thresholds',
        baselineSha: 'abc123',
        completedAt: Date.UTC(2026, 9, 17, 12, 30)
      },
      [MODIFIED, ADDED]
    )
    const [preamble, ...sections] = text.split('diff --git ')
    expect(preamble).toContain('MechBay mission patch\n')
    expect(preamble).toContain('Mech: Atlas-Prime\n')
    expect(preamble).toContain('Project: reactor-control\n')
    expect(preamble).toContain('Task: Tighten the sensor thresholds\n')
    expect(preamble).toContain('Baseline: abc123\n')
    expect(preamble).toContain('Completed: 2026-10-17T12:30:00.000Z\n')
    expect(preamble).toContain('Files: 2\n')
    expect(preamble).toContain('Apply with: git apply')
    expect(sections).toHaveLength(2)
    expect(sections[0]).toMatch(/^a\/src\/app\.ts b\/src\/app\.ts\n/)
    expect(sections[1]).toMatch(/^a\/docs\/new\.md b\/docs\/new\.md\n/)
  })

  it('names truncated and unreadable files so the reader knows the patch is partial', () => {
    const text = renderMissionPatch(
      { mech: 'Raven-Prime', project: 'p', task: 't', unreadable: ['secret/key.pem'] },
      [{ ...MODIFIED, truncated: true }]
    )
    expect(text).toContain('Truncated (too large to export in full): src/app.ts\n')
    expect(text).toContain('Not exported (could not be read): secret/key.pem\n')
  })
})

describe('missionPatchFileName', () => {
  it('slugs the mech and project and stamps the completion time', () => {
    const name = missionPatchFileName(
      'Atlas-Prime',
      'Reactor Control (v2)',
      new Date(2026, 9, 17, 9, 5).getTime()
    )
    expect(name).toBe('mechbay-atlas-prime-reactor-control-v2-20261017-0905.patch')
  })

  it('never produces an empty or oversized slug', () => {
    const name = missionPatchFileName('***', 'x'.repeat(80), 0)
    expect(name).toMatch(/^mechbay-mission-x{32}-\d{8}-\d{4}\.patch$/)
  })
})
