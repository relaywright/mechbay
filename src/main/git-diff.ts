import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises'
import path from 'node:path'
import type { DiffFileStat, DiffHunk, DiffLine, FilePatch } from '../shared/types'
import { parseUnifiedDiff } from '../shared/diff-parse'

export type { DiffFileStat } from '../shared/types'
export { parseUnifiedDiff } from '../shared/diff-parse'

export interface DiffSummary {
  filesChanged: number
  insertions: number
  deletions: number
  files: DiffFileStat[]
}

const execFileAsync = promisify(execFile)
const GIT_TIMEOUT_MS = 5000
const GIT_MAX_BUFFER = 10 * 1024 * 1024
const FILE_LIST_LIMIT = 50

// Untracked-file line counting: anything bigger than this, or containing a
// NUL byte in its first probe window, is treated as binary/unreadable and
// contributes 0 rather than risk loading a huge blob into memory.
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024
const BINARY_PROBE_BYTES = 8 * 1024

const PATCH_MAX_LINES = 3000
const PATCH_MAX_BYTES = 400 * 1024

async function runGit(
  repoPath: string,
  args: string[],
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', repoPath, ...args], {
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: GIT_MAX_BUFFER,
      windowsHide: true,
      signal
    })
    return stdout
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.error(`[git-diff] git ${args.join(' ')} failed: ${message}`)
    return null
  }
}

/**
 * realpath() of `target`, or of its nearest ancestor that still exists.
 * A mission that deletes a whole directory leaves diff entries whose parent
 * folder is gone, and plain realpath() throws ENOENT on those, which would
 * misreport a normal deletion as a containment escape. Climbing to the
 * nearest existing ancestor is just as safe: a path segment that doesn't
 * exist can't be a symlink, so only existing segments can redirect.
 */
async function realpathOfNearestExisting(target: string): Promise<string> {
  let current = target
  for (;;) {
    try {
      return await realpath(current)
    } catch (err) {
      const parent = path.dirname(current)
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT' || parent === current) throw err
      current = parent
    }
  }
}

/**
 * Resolves filePath against repoPath and guards the result can't escape it,
 * against BOTH kinds of symlink escape:
 *  - a symlinked ancestor directory of the target (e.g. `linkdir -> /etc`,
 *    then reading `linkdir/passwd`) — caught by realpath-ing the target's
 *    containing directory and comparing it against repoPath's realpath.
 *  - repoPath itself being reached through a symlinked temp dir (macOS
 *    `/var -> /private/var`) — handled by realpath-ing repoPath too, so
 *    both sides of the comparison are canonical.
 * Deliberately does NOT resolve the final path component through
 * `realpath` — callers need to see with `lstat` whether the file ITSELF is
 * a symlink (e.g. `leak -> ~/.ssh/id_rsa`), so its target is never read.
 */
export async function resolveInRepo(repoPath: string, filePath: string): Promise<string | null> {
  const root = path.resolve(repoPath)
  const resolved = path.resolve(repoPath, filePath)
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null

  try {
    const [realRoot, realParent] = await Promise.all([
      realpath(root),
      realpathOfNearestExisting(path.dirname(resolved))
    ])
    if (realParent !== realRoot && !realParent.startsWith(realRoot + path.sep)) return null
  } catch {
    return null
  }

  return resolved
}

type FileRead =
  { kind: 'text'; lines: string[] } | { kind: 'symlink'; target: string } | { kind: 'skip' } // binary, too large, missing, or otherwise unreadable

/**
 * Reads a file from disk for diffing purposes. Symlinks are reported as
 * such (never followed) — a caller that reads through a symlink would
 * silently count/render whatever the link points at, which for an
 * attacker-planted link (`leak -> ~/.ssh/id_rsa`) means exfiltrating file
 * contents into the debrief UI. `lstat` (not `stat`) is what makes this
 * safe: it inspects the link itself rather than following it.
 */
async function readFileForDiff(resolvedPath: string): Promise<FileRead> {
  try {
    const info = await lstat(resolvedPath)
    if (info.isSymbolicLink()) {
      const target = await readlink(resolvedPath)
      return { kind: 'symlink', target }
    }
    if (!info.isFile() || info.size > UNTRACKED_MAX_BYTES) return { kind: 'skip' }

    const probeSize = Math.min(info.size, BINARY_PROBE_BYTES)
    if (probeSize > 0) {
      const handle = await open(resolvedPath, 'r')
      try {
        const buffer = Buffer.alloc(probeSize)
        await handle.read(buffer, 0, probeSize, 0)
        if (buffer.includes(0)) return { kind: 'skip' }
      } finally {
        await handle.close()
      }
    }

    const content = await readFile(resolvedPath, 'utf8')
    if (content.length === 0) return { kind: 'text', lines: [] }
    const lines = content.split(/\r?\n/)
    if (content.endsWith('\n')) lines.pop()
    return { kind: 'text', lines }
  } catch (err) {
    console.error(`[git-diff] unable to read ${resolvedPath}:`, err)
    return { kind: 'skip' }
  }
}

async function countUntrackedInsertions(repoPath: string, filePath: string): Promise<number> {
  const resolved = await resolveInRepo(repoPath, filePath)
  if (!resolved) return 0
  const result = await readFileForDiff(resolved)
  return result.kind === 'text' ? result.lines.length : 0
}

function parseNumstat(output: string): DiffFileStat[] {
  const files: DiffFileStat[] = []

  for (const row of output.split(/\r?\n/)) {
    if (!row) continue
    const [insertions, deletions, ...pathParts] = row.split('\t')
    const filePath = pathParts.join('\t')
    if (!filePath) continue
    files.push({
      path: filePath,
      insertions: insertions === '-' ? 0 : Number.parseInt(insertions, 10) || 0,
      deletions: deletions === '-' ? 0 : Number.parseInt(deletions, 10) || 0
    })
  }

  return files
}

function parseStatus(output: string, untrackedOnly: boolean): DiffFileStat[] {
  const files: DiffFileStat[] = []

  for (const row of output.split(/\r?\n/)) {
    if (row.length < 4 || (untrackedOnly && !row.startsWith('??'))) continue
    files.push({ path: row.slice(3), insertions: 0, deletions: 0 })
  }

  return files
}

function summarize(files: DiffFileStat[]): DiffSummary {
  return {
    filesChanged: files.length,
    insertions: files.reduce((total, file) => total + file.insertions, 0),
    deletions: files.reduce((total, file) => total + file.deletions, 0),
    files: files.slice(0, FILE_LIST_LIMIT)
  }
}

export async function captureGitBaseline(repoPath: string): Promise<string | null> {
  const stdout = await runGit(repoPath, ['rev-parse', 'HEAD'])
  const sha = stdout?.trim()
  return sha || null
}

export async function computeDiffSummary(
  repoPath: string,
  baselineSha: string | null
): Promise<DiffSummary | null> {
  const abortController = new AbortController()
  const deadline = setTimeout(() => abortController.abort(), GIT_TIMEOUT_MS)

  try {
    if (baselineSha) {
      const numstat = await runGit(
        repoPath,
        ['diff', '--numstat', baselineSha],
        abortController.signal
      )
      if (numstat === null) return null

      // -uall: without it, a new untracked DIRECTORY collapses to a single
      // `?? dir/` row instead of listing the files inside it individually.
      const status = await runGit(
        repoPath,
        ['status', '--porcelain', '-uall'],
        abortController.signal
      )
      if (status === null) return null

      const files = parseNumstat(numstat)
      const existingPaths = new Set(files.map((file) => file.path))
      const untracked = parseStatus(status, true).filter((file) => !existingPaths.has(file.path))
      for (const file of untracked) {
        file.insertions = await countUntrackedInsertions(repoPath, file.path)
        files.push(file)
      }
      return summarize(files)
    }

    const isGitRepo = await runGit(
      repoPath,
      ['rev-parse', '--is-inside-work-tree'],
      abortController.signal
    )
    if (isGitRepo?.trim() !== 'true') return null

    const status = await runGit(
      repoPath,
      ['status', '--porcelain', '-uall'],
      abortController.signal
    )
    if (status === null) return null
    return summarize(parseStatus(status, false))
  } catch (err) {
    console.error('[git-diff] unable to compute diff summary:', err)
    return null
  } finally {
    clearTimeout(deadline)
  }
}

/** Caps total rendered lines at PATCH_MAX_LINES, dropping trailing hunks/lines past the cap. */
function capHunks(hunks: DiffHunk[]): { hunks: DiffHunk[]; truncated: boolean } {
  const capped: DiffHunk[] = []
  let lineCount = 0
  let truncated = false

  for (const hunk of hunks) {
    if (lineCount >= PATCH_MAX_LINES) {
      truncated = true
      break
    }
    const remaining = PATCH_MAX_LINES - lineCount
    if (hunk.lines.length > remaining) {
      capped.push({ header: hunk.header, lines: hunk.lines.slice(0, remaining) })
      lineCount += remaining
      truncated = true
      break
    }
    capped.push(hunk)
    lineCount += hunk.lines.length
  }

  return { hunks: capped, truncated }
}

function isBinaryDiffOutput(diffText: string): boolean {
  return diffText.includes('GIT binary patch') || /^Binary files .* differ$/m.test(diffText)
}

function patchFromGitDiff(filePath: string, diffText: string): FilePatch {
  if (isBinaryDiffOutput(diffText)) {
    return { path: filePath, binary: true, truncated: false, hunks: [] }
  }

  let text = diffText
  let byteTruncated = false
  if (Buffer.byteLength(text, 'utf8') > PATCH_MAX_BYTES) {
    text = text.slice(0, PATCH_MAX_BYTES)
    byteTruncated = true
  }

  const { hunks, truncated: lineTruncated } = capHunks(parseUnifiedDiff(text))
  return { path: filePath, binary: false, truncated: byteTruncated || lineTruncated, hunks }
}

/** Synthesizes an all-added patch for a brand-new (untracked) file — there's no git diff to run against. */
async function synthesizeAddedPatch(repoPath: string, filePath: string): Promise<FilePatch> {
  const resolved = await resolveInRepo(repoPath, filePath)
  if (!resolved) return { path: filePath, binary: true, truncated: false, hunks: [] }

  const result = await readFileForDiff(resolved)

  if (result.kind === 'skip') return { path: filePath, binary: true, truncated: false, hunks: [] }

  if (result.kind === 'symlink') {
    // Mirrors what `git diff` itself shows for a symlink: one added line
    // holding the link target string. Never the target FILE's contents —
    // readFileForDiff refused to follow the link in the first place.
    const hunk: DiffHunk = {
      header: '@@ -0,0 +1,1 @@',
      lines: [{ kind: 'add', text: result.target, newNo: 1 }]
    }
    return { path: filePath, binary: false, truncated: false, hunks: [hunk] }
  }

  if (result.lines.length === 0)
    return { path: filePath, binary: false, truncated: false, hunks: [] }

  const hunk: DiffHunk = {
    header: `@@ -0,0 +1,${result.lines.length} @@`,
    lines: result.lines.map((text, i): DiffLine => ({ kind: 'add', text, newNo: i + 1 }))
  }
  const { hunks, truncated } = capHunks([hunk])
  return { path: filePath, binary: false, truncated, hunks }
}

async function isUntracked(repoPath: string, filePath: string): Promise<boolean> {
  const status = await runGit(repoPath, ['status', '--porcelain', '-uall', '--', filePath])
  if (status === null) return false
  return status.split(/\r?\n/).some((row) => row.startsWith('?? ') && row.slice(3) === filePath)
}

/**
 * Returns the unified-diff patch for a single file, against `baselineSha`
 * (or HEAD when there's no baseline). Untracked files have no git history
 * to diff against, so their patch is synthesized as all-added lines from
 * their current content. Returns null only on a git-level failure (e.g.
 * the path escapes the repo, or git itself errors) — a file with no
 * changes still resolves to a FilePatch with empty hunks.
 */
export async function readFilePatch(
  repoPath: string,
  baselineSha: string | null,
  filePath: string
): Promise<FilePatch | null> {
  const resolved = await resolveInRepo(repoPath, filePath)
  if (!resolved) return null

  if (await isUntracked(repoPath, filePath)) {
    return synthesizeAddedPatch(repoPath, filePath)
  }

  const revision = baselineSha ?? 'HEAD'
  const diffText = await runGit(repoPath, [
    'diff',
    '--no-color',
    '--no-ext-diff',
    '--unified=3',
    revision,
    '--',
    filePath
  ])
  if (diffText === null) return null

  return patchFromGitDiff(filePath, diffText)
}
