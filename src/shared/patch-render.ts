/**
 * Pure unified-diff renderer: the inverse of diff-parse.ts. Turns the
 * FilePatch structures the Mission Debrief already shows back into text that
 * `git apply` and `patch -p1` accept, so a mission's changes can be carried
 * to another checkout or attached to a review. No fs/git/electron imports,
 * so it is unit-testable in isolation and usable from either process.
 */
import type { DiffLine, FilePatch } from './types'

export interface MissionPatchHeader {
  mech: string
  project: string
  task: string
  /** Pre-mission commit the diff was taken against, when the project had one. */
  baselineSha?: string
  /** Mission completion time, as epoch milliseconds. */
  completedAt?: number
  /** Paths the exporter could not read; listed so the reader knows the patch is partial. */
  unreadable?: string[]
}

const LINE_PREFIX: Record<DiffLine['kind'], string> = { add: '+', del: '-', ctx: ' ' }

/** True for a patch synthesized from an untracked file (every hunk starts at old line 0). */
function isNewFile(patch: FilePatch): boolean {
  return patch.hunks.length > 0 && patch.hunks.every((hunk) => /^@@ -0,0 /.test(hunk.header))
}

/**
 * One file as a `diff --git` section. Binary files get git's own marker line
 * and no hunks. The parser drops "\ No newline at end of file" markers, so a
 * file that lost its final newline re-applies with one; git reports that as
 * trailing whitespace, not as a failure.
 */
export function renderFilePatch(patch: FilePatch): string {
  const lines = [`diff --git a/${patch.path} b/${patch.path}`]
  if (patch.binary) {
    lines.push(`Binary files a/${patch.path} and b/${patch.path} differ`)
    return lines.join('\n') + '\n'
  }
  if (patch.hunks.length === 0) return ''
  const added = isNewFile(patch)
  if (added) lines.push('new file mode 100644')
  lines.push(added ? '--- /dev/null' : `--- a/${patch.path}`, `+++ b/${patch.path}`)
  for (const hunk of patch.hunks) {
    lines.push(hunk.header)
    for (const line of hunk.lines) lines.push(LINE_PREFIX[line.kind] + line.text)
  }
  return lines.join('\n') + '\n'
}

/**
 * A whole mission as one patch file. The preamble is plain text before the
 * first `diff --git` line, which git apply and patch both skip, the same way
 * they skip the mail headers of a format-patch file.
 */
export function renderMissionPatch(header: MissionPatchHeader, patches: FilePatch[]): string {
  const truncated = patches.filter((patch) => patch.truncated).map((patch) => patch.path)
  const preamble = [
    'MechBay mission patch',
    `Mech: ${header.mech}`,
    `Project: ${header.project}`,
    `Task: ${header.task.replace(/\s+/g, ' ').trim()}`
  ]
  if (header.baselineSha) preamble.push(`Baseline: ${header.baselineSha}`)
  if (header.completedAt !== undefined)
    preamble.push(`Completed: ${new Date(header.completedAt).toISOString()}`)
  preamble.push(`Files: ${patches.length}`)
  if (truncated.length > 0)
    preamble.push(`Truncated (too large to export in full): ${truncated.join(', ')}`)
  if (header.unreadable?.length)
    preamble.push(`Not exported (could not be read): ${header.unreadable.join(', ')}`)
  preamble.push('Apply with: git apply <file>.patch', '')

  const body = patches.map(renderFilePatch).filter((text) => text.length > 0)
  return preamble.join('\n') + '\n' + body.join('')
}

/** A file name safe on every desktop OS: `mechbay-<mech>-<project>-<stamp>.patch`. */
export function missionPatchFileName(mech: string, project: string, completedAt: number): string {
  const slug = (text: string): string =>
    text
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 32) || 'mission'
  const date = new Date(completedAt)
  const pad = (n: number): string => n.toString().padStart(2, '0')
  const stamp = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}`
  return `mechbay-${slug(mech)}-${slug(project)}-${stamp}.patch`
}
