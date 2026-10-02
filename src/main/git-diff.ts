import { execFile, type ExecFileOptionsWithStringEncoding } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { lstat, open, readFile, readlink, realpath } from 'node:fs/promises'
import os from 'node:os'
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

// A mission can rewrite the facility's .git/config and hooks. Every git call
// MechBay makes goes through execGit with these global options: no optional
// index writes, no fsmonitor hook, no transport at all (so a lazy fetch can't
// reach core.sshCommand), and hooks looked up in a folder that never exists.
// Diff calls also pass --no-ext-diff --no-textconv, status and diff pass
// --ignore-submodules=dirty and diffs --submodule=short (a submodule is
// another repo with its own config; only its pointer shows), and every call
// that can read file content first passes repoGuard (see below).
const HOOKS_OFF = path.join(os.tmpdir(), `mechbay-no-hooks-${randomUUID()}`)
const SAFE_GIT_OPTIONS = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
  '-c',
  `core.hooksPath=${HOOKS_OFF}`
]

/** The person's own choice of trusted config files; every other GIT_* variable is dropped. */
const KEPT_GIT_ENV = new Set(['GIT_CONFIG_GLOBAL', 'GIT_CONFIG_SYSTEM', 'GIT_CONFIG_NOSYSTEM'])

/** Config scopes the person sets up themselves; their filters (e.g. Git LFS) stay on. */
const TRUSTED_CONFIG_SCOPES = new Set(['global', 'system'])
const FILTER_COMMANDS = ['clean', 'smudge', 'process']

/**
 * MechBay's environment minus inherited GIT_* variables (an inherited
 * GIT_DIR, GIT_WORK_TREE or GIT_CONFIG would point git at another repo or
 * make the filter lookup read a different file than status does), plus
 * settings that keep git offline, lock-free and non-interactive. Names are
 * compared case-insensitively because Windows environment names are.
 * GIT_ALLOW_PROTOCOL is an allowlist that repo config (protocol.<name>.allow)
 * cannot widen. Its only entry is '0', a name no URL can carry: git reads
 * `<name>::` as a remote helper only when the name is empty or starts with a
 * letter. An empty value would be a list holding '', which allows a `::x`
 * URL and runs a `git-remote-` helper on PATH; 'none' would likewise allow
 * `none::x` and run git-remote-none.
 */
export function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [name, value] of Object.entries(process.env)) {
    const upper = name.toUpperCase()
    if (upper.startsWith('GIT_') && !KEPT_GIT_ENV.has(upper)) continue
    env[name] = value
  }
  return {
    ...env,
    GIT_ALLOW_PROTOCOL: '0',
    GIT_NO_LAZY_FETCH: '1',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0'
  }
}

/** The one way MechBay runs git: safe options, filter overrides, clean env. */
function execGit(
  repoPath: string,
  args: string[],
  filterOverrides: readonly string[],
  signal?: AbortSignal
): Promise<{ stdout: string }> {
  const options: ExecFileOptionsWithStringEncoding = {
    encoding: 'utf8',
    env: gitEnv(),
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    signal
  }
  return execFileAsync(
    'git',
    [...SAFE_GIT_OPTIONS, ...filterOverrides, '-C', repoPath, ...args],
    options
  )
}

async function runGit(
  repoPath: string,
  args: string[],
  filterOverrides: readonly string[],
  signal?: AbortSignal
): Promise<string | null> {
  try {
    const { stdout } = await execGit(repoPath, args, filterOverrides, signal)
    return stdout
  } catch (err) {
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.error(`[git-diff] git ${args.join(' ')} failed: ${message}`)
    return null
  }
}

/**
 * Turns `git config --show-scope --name-only --get-regexp ^(filter|lfs)\.`
 * output into `-c` options that switch off every filter driver defined
 * anywhere but the person's own global or system config. The trusted Git
 * LFS driver is switched off too when the repo defines LFS extension
 * commands (lfs.extension.<name>.clean/smudge), because git-lfs runs those
 * from the repo's config; other lfs.* settings don't run programs. Returns
 * null (fail closed) when a line can't be parsed or a driver name can't be
 * passed safely with -c.
 */
export function filterOverridesFromConfig(output: string): string[] | null {
  const drivers = new Set<string>()
  for (const line of output.split(/\r?\n/)) {
    if (!line) continue
    const tab = line.indexOf('\t')
    const key = line.slice(tab + 1)
    if (tab === -1 || !/^(filter|lfs)\./.test(key)) return null
    if (TRUSTED_CONFIG_SCOPES.has(line.slice(0, tab))) continue
    if (key.startsWith('lfs.')) {
      // git-lfs reads its config keys case-insensitively.
      if (key.toLowerCase().startsWith('lfs.extension.')) drivers.add('lfs')
      continue
    }
    // Driver names may contain dots: filter.a.b.clean is driver "a.b".
    const name = key.slice('filter.'.length, key.lastIndexOf('.'))
    if (!name || /[=\r\n]/.test(name)) return null
    drivers.add(name)
  }
  return [...drivers].flatMap((name) => [
    ...FILTER_COMMANDS.flatMap((command) => ['-c', `filter.${name}.${command}=`]),
    '-c',
    `filter.${name}.required=false`
  ])
}

/**
 * Lists the repo's filter drivers (reading config never runs a program) and
 * returns the -c options that blank them, or null if that can't be done
 * safely, in which case the caller shows no diff rather than run git
 * unprotected.
 */
async function repoFilterOverrides(
  repoPath: string,
  signal?: AbortSignal
): Promise<string[] | null> {
  const args = [
    'config',
    '--includes',
    '--show-scope',
    '--name-only',
    '--get-regexp',
    '^(filter|lfs)\\.'
  ]
  try {
    const { stdout } = await execGit(repoPath, args, [], signal)
    const overrides = filterOverridesFromConfig(stdout)
    if (!overrides) console.error('[git-diff] refusing to diff: unsafe filter driver config')
    return overrides
  } catch (err) {
    // Exit 1 with no output is git's "no matching keys".
    const { code, stdout } = err as { code?: unknown; stdout?: unknown }
    if (code === 1 && !stdout) return []
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.error(`[git-diff] git ${args.join(' ')} failed: ${message}`)
    return null
  }
}

/**
 * True unless the repo's config points git at a working folder other than
 * the project (core.worktree), which would make the diff read files outside
 * it under names that look like the project's own. Normal repos never set
 * core.worktree; a submodule's git dir sets it to that same submodule
 * folder, which passes.
 */
async function worktreeIsProject(repoPath: string, signal?: AbortSignal): Promise<boolean> {
  const args = ['config', '--get', 'core.worktree']
  try {
    await execGit(repoPath, args, [], signal)
  } catch (err) {
    // Exit 1 with no output is git's "not set".
    const { code, stdout } = err as { code?: unknown; stdout?: unknown }
    if (code === 1 && !stdout) return true
    const message = err instanceof Error ? err.message.split('\n')[0] : String(err)
    console.error(`[git-diff] git ${args.join(' ')} failed: ${message}`)
    return false
  }

  const toplevel = (await runGit(repoPath, ['rev-parse', '--show-toplevel'], [], signal))?.trim()
  if (toplevel) {
    const [realTop, realRepo] = await Promise.all([
      realpath(toplevel).catch(() => null),
      realpath(repoPath).catch(() => null)
    ])
    const fold = (p: string): string => (process.platform === 'win32' ? p.toLowerCase() : p)
    if (realTop && realRepo && fold(realTop) === fold(realRepo)) return true
  }
  console.error('[git-diff] refusing to diff: core.worktree points outside the project')
  return false
}

/**
 * The one guard every content-reading git call passes first: the worktree
 * must be the project itself, and the repo's filter drivers get blanked.
 * Returns the filter overrides, or null when git must not run at all.
 */
async function repoGuard(repoPath: string, signal?: AbortSignal): Promise<string[] | null> {
  if (!(await worktreeIsProject(repoPath, signal))) return null
  return repoFilterOverrides(repoPath, signal)
}

/**
 * Whether repoPath is in a git repository: 'repo' when git says so (with or
 * without commits), 'unknown' when git can't tell but a `.git` entry sits in
 * repoPath or a folder above it (a malformed config, say), and 'none' only
 * when there is no `.git` anywhere. That last check uses the file system,
 * so repo config can't fake it and it doesn't depend on git's language.
 * rev-parse reads no file contents, so it needs no guard.
 */
export async function isGitRepository(repoPath: string): Promise<'repo' | 'none' | 'unknown'> {
  const stdout = await runGit(repoPath, ['rev-parse', '--is-inside-work-tree'], [])
  if (stdout?.trim() === 'true') return 'repo'
  for (let dir = path.resolve(repoPath); ; dir = path.dirname(dir)) {
    if (await pathExists(path.join(dir, '.git'))) return 'unknown'
    if (path.dirname(dir) === dir) return 'none'
  }
}

/** True when something (file, folder or link) exists at `target`. */
async function pathExists(target: string): Promise<boolean> {
  return lstat(target).then(
    () => true,
    () => false
  )
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
  // rev-parse HEAD never reads working-tree files, so no filter overrides.
  const stdout = await runGit(repoPath, ['rev-parse', 'HEAD'], [])
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
    const overrides = await repoGuard(repoPath, abortController.signal)
    if (overrides === null) return null

    if (baselineSha) {
      const numstat = await runGit(
        repoPath,
        [
          'diff',
          '--numstat',
          '--no-ext-diff',
          '--no-textconv',
          '--ignore-submodules=dirty',
          '--submodule=short',
          baselineSha
        ],
        overrides,
        abortController.signal
      )
      if (numstat === null) return null

      // -uall: without it, a new untracked DIRECTORY collapses to a single
      // `?? dir/` row instead of listing the files inside it individually.
      const status = await runGit(
        repoPath,
        ['status', '--porcelain', '-uall', '--ignore-submodules=dirty'],
        overrides,
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
      overrides,
      abortController.signal
    )
    if (isGitRepo?.trim() !== 'true') return null

    const status = await runGit(
      repoPath,
      ['status', '--porcelain', '-uall', '--ignore-submodules=dirty'],
      overrides,
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

async function isUntracked(
  repoPath: string,
  filePath: string,
  filterOverrides: readonly string[]
): Promise<boolean> {
  const status = await runGit(
    repoPath,
    ['status', '--porcelain', '-uall', '--ignore-submodules=dirty', '--', filePath],
    filterOverrides
  )
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

  const overrides = await repoGuard(repoPath)
  if (overrides === null) return null

  if (await isUntracked(repoPath, filePath, overrides)) {
    return synthesizeAddedPatch(repoPath, filePath)
  }

  const revision = baselineSha ?? 'HEAD'
  const diffText = await runGit(
    repoPath,
    [
      'diff',
      '--no-color',
      '--no-ext-diff',
      '--no-textconv',
      '--ignore-submodules=dirty',
      '--submodule=short',
      '--unified=3',
      revision,
      '--',
      filePath
    ],
    overrides
  )
  if (diffText === null) return null

  return patchFromGitDiff(filePath, diffText)
}
