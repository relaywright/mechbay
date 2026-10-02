import { afterEach, describe, expect, it, vi } from 'vitest'
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import {
  access,
  chmod,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  symlink,
  utimes,
  writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import {
  captureGitBaseline,
  computeDiffSummary,
  gitEnv,
  isGitRepository,
  readFilePatch
} from '../../src/main/git-diff'

const execFileAsync = promisify(execFile)
const tempDirs: string[] = []

async function runGit(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync('git', ['-C', repoPath, ...args], { windowsHide: true })
}

/**
 * Creates a symlink, returning false instead of throwing when this can't
 * be done — Windows requires admin rights or Developer Mode to create
 * symlinks, so `EPERM` there means "can't test this on this machine",
 * not "the feature is broken". Callers should skip (return early from)
 * the test when this comes back false.
 */
async function trySymlink(
  target: string,
  linkPath: string,
  type: 'file' | 'dir'
): Promise<boolean> {
  try {
    await symlink(target, linkPath, type)
    return true
  } catch (err) {
    if (err instanceof Error && 'code' in err && err.code === 'EPERM') return false
    throw err
  }
}

async function makeRepo(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), 'mechbay-git-diff-'))
  tempDirs.push(repoPath)
  await runGit(repoPath, ['init'])
  await runGit(repoPath, ['config', 'user.email', 'test@mechbay.local'])
  await runGit(repoPath, ['config', 'user.name', 'MechBay Test'])
  await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nline two\n')
  await runGit(repoPath, ['add', 'tracked.txt'])
  await runGit(repoPath, ['commit', '-m', 'initial'])
  return repoPath
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

// These tests drive real git subprocesses. Each spawn costs a few hundred ms
// on Windows, so under a full parallel suite run a test can pass Vitest's
// 5 s default without anything being wrong.
const GIT_TEST_TIMEOUT_MS = 20_000

describe('git diff capture', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('captures a baseline and summarizes tracked plus untracked changes', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nupdated line\nadded line\n')
    await writeFile(path.join(repoPath, 'untracked.txt'), 'not yet added\n')

    const diff = await computeDiffSummary(repoPath, baselineSha)

    expect(baselineSha).toMatch(/^[0-9a-f]{40}$/)
    expect(diff).not.toBeNull()
    expect(diff).toMatchObject({ filesChanged: 2, insertions: 3, deletions: 1 })
    expect(diff?.files).toEqual(
      expect.arrayContaining([
        { path: 'tracked.txt', insertions: 2, deletions: 1 },
        { path: 'untracked.txt', insertions: 1, deletions: 0 }
      ])
    )
  })

  it('counts each file inside a new untracked directory individually', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await mkdir(path.join(repoPath, 'newdir'))
    await writeFile(path.join(repoPath, 'newdir', 'a.txt'), 'one\ntwo\n')
    await writeFile(path.join(repoPath, 'newdir', 'b.txt'), 'solo line\n')

    const diff = await computeDiffSummary(repoPath, baselineSha)

    expect(diff).not.toBeNull()
    expect(diff?.files).toEqual(
      expect.arrayContaining([
        { path: 'newdir/a.txt', insertions: 2, deletions: 0 },
        { path: 'newdir/b.txt', insertions: 1, deletions: 0 }
      ])
    )
  })

  it('returns null for a directory that is not a git repository', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'mechbay-not-git-'))
    tempDirs.push(directory)
    await mkdir(path.join(directory, 'nested'))

    await expect(captureGitBaseline(directory)).resolves.toBeNull()
    await expect(computeDiffSummary(directory, null)).resolves.toBeNull()
  })

  it('falls back to porcelain file counts for a repository without commits', async () => {
    const repoPath = await mkdtemp(path.join(tmpdir(), 'mechbay-unborn-repo-'))
    tempDirs.push(repoPath)
    await runGit(repoPath, ['init'])
    await writeFile(path.join(repoPath, 'pending.txt'), 'waiting for first commit\n')

    await expect(captureGitBaseline(repoPath)).resolves.toBeNull()
    await expect(computeDiffSummary(repoPath, null)).resolves.toEqual({
      filesChanged: 1,
      insertions: 0,
      deletions: 0,
      files: [{ path: 'pending.txt', insertions: 0, deletions: 0 }]
    })
  })

  it('counts binary numstat rows as changed files with zero line totals', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await writeFile(path.join(repoPath, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))
    await runGit(repoPath, ['add', 'asset.bin'])
    await runGit(repoPath, ['commit', '-m', 'add binary asset'])

    const diff = await computeDiffSummary(repoPath, baselineSha)

    expect(diff).not.toBeNull()
    expect(diff).toMatchObject({ filesChanged: 1, insertions: 0, deletions: 0 })
    expect(diff?.files).toContainEqual({ path: 'asset.bin', insertions: 0, deletions: 0 })
  })
})

describe('readFilePatch', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('returns a unified-diff patch for a tracked change against the baseline', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nupdated line\nadded line\n')

    const patch = await readFilePatch(repoPath, baselineSha, 'tracked.txt')

    expect(patch).not.toBeNull()
    expect(patch?.binary).toBe(false)
    expect(patch?.truncated).toBe(false)
    expect(patch?.hunks.length).toBeGreaterThan(0)
    const kinds = patch?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.kind))
    expect(kinds).toContain('add')
    expect(kinds).toContain('del')
    expect(kinds).toContain('ctx')
  })

  it('shows a file deleted along with its whole directory as all-removed lines', async () => {
    // Regression guard: realpath-based containment must not treat a
    // directory the agent deleted as an escape. Removing a whole module
    // folder is a normal mission, and its files must still be viewable.
    const repoPath = await makeRepo()
    await mkdir(path.join(repoPath, 'legacy'))
    await writeFile(path.join(repoPath, 'legacy', 'old-router.ts'), 'export const route = 1\n')
    await runGit(repoPath, ['add', 'legacy/old-router.ts'])
    await runGit(repoPath, ['commit', '-m', 'add legacy router'])
    const baselineSha = await captureGitBaseline(repoPath)

    await rm(path.join(repoPath, 'legacy'), { recursive: true, force: true })

    const patch = await readFilePatch(repoPath, baselineSha, 'legacy/old-router.ts')

    expect(patch).not.toBeNull()
    const lines = patch?.hunks.flatMap((hunk) => hunk.lines) ?? []
    expect(lines).toEqual([{ kind: 'del', text: 'export const route = 1', oldNo: 1 }])
  })

  it('synthesizes an all-added patch for an untracked file', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await writeFile(path.join(repoPath, 'new-notes.txt'), 'first thought\nsecond thought\n')

    const patch = await readFilePatch(repoPath, baselineSha, 'new-notes.txt')

    expect(patch).not.toBeNull()
    expect(patch?.binary).toBe(false)
    expect(patch?.hunks).toHaveLength(1)
    expect(patch?.hunks[0].lines).toEqual([
      { kind: 'add', text: 'first thought', newNo: 1 },
      { kind: 'add', text: 'second thought', newNo: 2 }
    ])
  })

  it('reports binary files without attempting a line diff', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    await writeFile(path.join(repoPath, 'asset.bin'), Buffer.from([0, 1, 2, 3, 4]))
    await runGit(repoPath, ['add', 'asset.bin'])
    await runGit(repoPath, ['commit', '-m', 'add binary asset'])

    const patch = await readFilePatch(repoPath, baselineSha, 'asset.bin')

    expect(patch).toEqual({ path: 'asset.bin', binary: true, truncated: false, hunks: [] })
  })

  it('refuses to read outside the repository even with a traversal path', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    const patch = await readFilePatch(repoPath, baselineSha, '../secrets.txt')

    expect(patch).toBeNull()
  })

  it('never follows an untracked symlink to a file outside the repo (security)', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-diff-outside-'))
    tempDirs.push(outsideDir)
    const secretFile = path.join(outsideDir, 'id_rsa')
    await writeFile(secretFile, 'THIS-IS-A-PRIVATE-KEY\n')

    const linkPath = path.join(repoPath, 'leak.txt')
    const created = await trySymlink(secretFile, linkPath, 'file')
    if (!created) {
      // Creating symlinks on Windows requires admin rights or Developer
      // Mode. Nothing to verify without one, so skip rather than fail.
      console.warn('[git-diff.test] skipping symlink test: symlinkSync not permitted (EPERM)')
      return
    }

    // Untracked-file line counting must report 0 for a symlink, not the
    // line count of whatever it points at.
    const diff = await computeDiffSummary(repoPath, baselineSha)
    expect(diff?.files).toContainEqual({ path: 'leak.txt', insertions: 0, deletions: 0 })

    // The synthesized patch must show the link target STRING (like git
    // itself does for a symlink), never the target file's contents.
    const patch = await readFilePatch(repoPath, baselineSha, 'leak.txt')
    expect(patch).not.toBeNull()
    expect(patch?.binary).toBe(false)
    const allText = patch?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text)).join('\n')
    expect(allText).not.toContain('THIS-IS-A-PRIVATE-KEY')
    expect(allText).toContain(secretFile)
  })

  it('refuses a file reached through a symlinked parent directory (security)', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    const outsideDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-diff-outside-'))
    tempDirs.push(outsideDir)
    await writeFile(path.join(outsideDir, 'passwd'), 'root:x:0:0:root:/root:/bin/bash\n')

    const linkDir = path.join(repoPath, 'linkdir')
    const created = await trySymlink(outsideDir, linkDir, 'dir')
    if (!created) {
      console.warn('[git-diff.test] skipping symlink test: symlinkSync not permitted (EPERM)')
      return
    }

    const patch = await readFilePatch(repoPath, baselineSha, 'linkdir/passwd')

    expect(patch).toBeNull()
  })
})

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

describe('repository-configured programs (security)', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('never runs an fsmonitor hook or a textconv driver the repository configured', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)

    // Markers live outside the repo so they never show up as untracked files.
    const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
    tempDirs.push(markerDir)
    const shellDir = markerDir.replaceAll('\\', '/')
    const fsmonitorMarker = path.join(markerDir, 'fsmonitor-ran')
    const textconvMarker = path.join(markerDir, 'textconv-ran')

    // Both commands run through git's shell, so a planted .git/config would
    // execute arbitrary code the moment MechBay opens a diff.
    const fsmonitorHook = `echo hit > '${shellDir}/fsmonitor-ran'; true`
    const textconvDriver = `echo hit > '${shellDir}/textconv-ran'; cat`
    await runGit(repoPath, ['config', 'core.fsmonitor', fsmonitorHook])
    await runGit(repoPath, ['config', 'diff.evil.textconv', textconvDriver])
    await writeFile(path.join(repoPath, '.gitattributes'), '*.txt diff=evil\n')
    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nchanged line\n')

    const diff = await computeDiffSummary(repoPath, baselineSha)
    const patch = await readFilePatch(repoPath, baselineSha, 'tracked.txt')

    expect(diff?.files).toContainEqual({ path: 'tracked.txt', insertions: 1, deletions: 1 })
    expect(patch?.hunks.length).toBeGreaterThan(0)
    expect(await exists(fsmonitorMarker)).toBe(false)
    expect(await exists(textconvMarker)).toBe(false)
  })

  it('never runs a repo clean filter, even for a racily clean file in git status', async () => {
    const repoPath = await makeRepo()
    const marker = await plantFilter(repoPath, 'clean')
    await racySameSizeEdit(repoPath)

    // No baseline: the summary comes from `git status` alone.
    const diff = await computeDiffSummary(repoPath, null)

    expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 0, deletions: 0 }])
    expect(await exists(marker)).toBe(false)
  })

  it('never runs a repo clean filter for numstat or the file patch', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)
    const marker = await plantFilter(repoPath, 'clean')
    await racySameSizeEdit(repoPath)

    const diff = await computeDiffSummary(repoPath, baselineSha)
    const patch = await readFilePatch(repoPath, baselineSha, 'tracked.txt')

    expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 1, deletions: 1 }])
    const lines = patch?.hunks.flatMap((hunk) => hunk.lines)
    expect(lines).toContainEqual(expect.objectContaining({ kind: 'del', text: 'line two' }))
    expect(lines).toContainEqual(expect.objectContaining({ kind: 'add', text: 'line TWO' }))
    expect(await exists(marker)).toBe(false)
  })

  it('never runs a repo long-running process filter and still produces the diff', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)
    const marker = await plantFilter(repoPath, 'process')
    await racySameSizeEdit(repoPath)

    const statusOnly = await computeDiffSummary(repoPath, null)
    const diff = await computeDiffSummary(repoPath, baselineSha)
    const patch = await readFilePatch(repoPath, baselineSha, 'tracked.txt')

    expect(statusOnly?.filesChanged).toBe(1)
    expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 1, deletions: 1 }])
    expect(patch?.hunks.length).toBeGreaterThan(0)
    expect(await exists(marker)).toBe(false)
  })

  it('still runs a filter the person set up in their own global git config', async () => {
    const repoPath = await makeRepo()
    const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
    tempDirs.push(markerDir)
    const marker = path.join(markerDir, 'trusted-ran')
    // A throwaway global config for git children of this test only; the
    // person's real ~/.gitconfig is never read or written.
    const globalConfig = path.join(markerDir, 'gitconfig')
    await execFileAsync('git', [
      'config',
      '--file',
      globalConfig,
      'filter.trusted.clean',
      `echo hit > '${marker.replaceAll('\\', '/')}'; cat`
    ])
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    await writeFile(path.join(repoPath, '.git', 'info', 'attributes'), '* filter=trusted\n')
    await racySameSizeEdit(repoPath)

    const diff = await computeDiffSummary(repoPath, null)

    expect(diff?.filesChanged).toBe(1)
    expect(await exists(marker)).toBe(true)
  })

  it('switches off the trusted Git LFS filter when the repo defines LFS extension commands', async () => {
    // Git LFS's own clean filter runs lfs.extension.<name>.clean commands from
    // the repo's config. A global filter.lfs.clean that writes a marker stands
    // in for git-lfs, so the test needs no git-lfs install.
    const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
    tempDirs.push(markerDir)
    const marker = path.join(markerDir, 'lfs-filter-ran')
    const globalConfig = path.join(markerDir, 'gitconfig')
    await execFileAsync('git', [
      'config',
      '--file',
      globalConfig,
      'filter.lfs.clean',
      `echo hit > '${marker.replaceAll('\\', '/')}'; cat`
    ])
    vi.stubEnv('GIT_CONFIG_GLOBAL', globalConfig)
    // A real system-wide git-lfs install defines filter.lfs.process, which git
    // prefers over clean; keep it out so the stand-in is what runs.
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    const lfsRepo = async (): Promise<string> => {
      const repoPath = await makeRepo()
      await writeFile(path.join(repoPath, '.git', 'info', 'attributes'), '* filter=lfs\n')
      await racySameSizeEdit(repoPath)
      return repoPath
    }

    // Control: with no extension in the repo, the trusted LFS filter runs.
    expect((await computeDiffSummary(await lfsRepo(), null))?.filesChanged).toBe(1)
    expect(await exists(marker)).toBe(true)
    await rm(marker)

    const repoPath = await lfsRepo()
    const extension = `echo hit > '${markerDir.replaceAll('\\', '/')}/extension-ran'; cat`
    await runGit(repoPath, ['config', 'lfs.extension.x.clean', extension])
    const diff = await computeDiffSummary(repoPath, null)

    expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 0, deletions: 0 }])
    expect(await exists(marker)).toBe(false)
  })

  it('shows no diff at all when a repo filter name cannot be safely overridden', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)
    await runGit(repoPath, ['config', 'filter.a=b.clean', 'cat'])
    await writeFile(path.join(repoPath, 'tracked.txt'), 'line one\nchanged line\n')

    await expect(computeDiffSummary(repoPath, baselineSha)).resolves.toBeNull()
    await expect(readFilePatch(repoPath, baselineSha, 'tracked.txt')).resolves.toBeNull()
  })

  it.each(['the hooks folder', 'core.hooksPath'])(
    'never runs a post-index-change hook planted via %s',
    async (where) => {
      const repoPath = await makeRepo()
      const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
      tempDirs.push(markerDir)
      const marker = path.join(markerDir, 'hook-ran')
      let hooksDir = path.join(repoPath, '.git', 'hooks')
      if (where === 'core.hooksPath') {
        hooksDir = path.join(markerDir, 'planted-hooks')
        await runGit(repoPath, ['config', 'core.hooksPath', hooksDir.replaceAll('\\', '/')])
      }
      await mkdir(hooksDir, { recursive: true })
      const hook = path.join(hooksDir, 'post-index-change')
      await writeFile(hook, `#!/bin/sh\necho hit > '${marker.replaceAll('\\', '/')}'\n`)
      await chmod(hook, 0o755)
      await racySameSizeEdit(repoPath)

      // Status refreshes the racily clean entry and would rewrite the index.
      const diff = await computeDiffSummary(repoPath, null)

      expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 0, deletions: 0 }])
      expect(await exists(marker)).toBe(false)
    }
  )

  it('still finds repo filters when an inherited GIT_CONFIG points elsewhere', async () => {
    const repoPath = await makeRepo()
    const marker = await plantFilter(repoPath, 'clean')
    await racySameSizeEdit(repoPath)
    // Only `git config` reads GIT_CONFIG, so without a clean environment the
    // filter lookup would see this empty file while status still ran the filter.
    const emptyConfig = path.join(path.dirname(marker), 'empty-config')
    await writeFile(emptyConfig, '')
    vi.stubEnv('GIT_CONFIG', emptyConfig)

    const diff = await computeDiffSummary(repoPath, null)

    expect(diff?.files).toEqual([{ path: 'tracked.txt', insertions: 0, deletions: 0 }])
    expect(await exists(marker)).toBe(false)
  })

  it("shows a moved submodule pointer without running the submodule's own filter", async () => {
    const { app, sub, baselineSha } = await makeMovedSubmodule()

    // The mission bumps the submodule, plants a filter in the submodule's own
    // config, and leaves a racily clean edit inside it.
    const marker = await plantFilter(sub, 'clean')
    await racySameSizeEdit(sub)

    const diff = await computeDiffSummary(app, baselineSha)
    const statusOnly = await computeDiffSummary(app, null)

    expect(diff?.files.map((file) => file.path)).toContain('lib')
    expect(statusOnly?.files.map((file) => file.path)).toContain('lib')
    expect(await exists(marker)).toBe(false)
  }, 60_000) // Two repos plus a submodule clone: many git spawns on Windows.

  it('still diffs a submodule folder opened as a project (its core.worktree is itself)', async () => {
    const { sub } = await makeMovedSubmodule()
    const { stdout } = await execFileAsync('git', ['-C', sub, 'config', '--get', 'core.worktree'])
    expect(stdout.trim()).not.toBe('')
    await writeFile(path.join(sub, 'tracked.txt'), 'line one\nchanged in the submodule\n')

    const diff = await computeDiffSummary(sub, await captureGitBaseline(sub))

    expect(diff?.files).toContainEqual({ path: 'tracked.txt', insertions: 1, deletions: 1 })
  }, 60_000)

  it("shows only the submodule pointer even when the repo asks for the submodule's content diff", async () => {
    const { app, sub, baselineSha } = await makeMovedSubmodule()
    const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
    tempDirs.push(markerDir)
    const shellDir = markerDir.replaceAll('\\', '/')
    // diff.submodule=diff makes git diff inside the submodule, which has its
    // own config: a textconv helper and a clean filter the superproject's
    // filter lookup never sees.
    const infoDir = path.join(await gitDir(sub), 'info')
    await mkdir(infoDir, { recursive: true })
    await writeFile(path.join(infoDir, 'attributes'), '* filter=evil diff=evil\n')
    await runGit(sub, ['config', 'filter.evil.clean', `echo hit > '${shellDir}/clean-ran'; cat`])
    await runGit(sub, [
      'config',
      'diff.evil.textconv',
      `echo hit > '${shellDir}/textconv-ran'; cat`
    ])
    await runGit(app, ['config', 'diff.submodule', 'diff'])

    const diff = await computeDiffSummary(app, baselineSha)
    const patch = await readFilePatch(app, baselineSha, 'lib')

    expect(diff?.files.map((file) => file.path)).toEqual(['lib'])
    const texts = patch?.hunks.flatMap((hunk) => hunk.lines.map((line) => line.text))
    expect(texts).toHaveLength(2)
    for (const text of texts ?? []) expect(text).toMatch(/^Subproject commit [0-9a-f]{40}$/)
    expect(await exists(path.join(markerDir, 'textconv-ran'))).toBe(false)
    expect(await exists(path.join(markerDir, 'clean-ran'))).toBe(false)
  }, 60_000)

  it('shows no diff when the repository points git at a working folder elsewhere', async () => {
    const repoPath = await makeRepo()
    const baselineSha = await captureGitBaseline(repoPath)
    // A folder outside the project holding a file with a tracked file's name.
    const outside = await mkdtemp(path.join(tmpdir(), 'mechbay-git-outside-'))
    tempDirs.push(outside)
    await writeFile(path.join(outside, 'tracked.txt'), 'OUTSIDE SECRET\n')
    await runGit(repoPath, ['config', 'core.worktree', outside.replaceAll('\\', '/')])

    await expect(computeDiffSummary(repoPath, baselineSha)).resolves.toBeNull()
    await expect(computeDiffSummary(repoPath, null)).resolves.toBeNull()
    await expect(readFilePatch(repoPath, baselineSha, 'tracked.txt')).resolves.toBeNull()
  })

  it('never lets repo config re-enable a transport for a lazy fetch of a missing object', async () => {
    // A bare origin with two commits, and a blobless partial clone of it:
    // the first commit's blob is never fetched.
    const seed = await makeRepo()
    await writeFile(path.join(seed, 'tracked.txt'), 'version two\n')
    await runGit(seed, ['commit', '-am', 'second'])
    const origin = await mkdtemp(path.join(tmpdir(), 'mechbay-git-origin-'))
    tempDirs.push(origin)
    await runGit(origin, ['init', '--bare'])
    await runGit(origin, ['config', 'uploadpack.allowFilter', 'true'])
    const originUrl = `file://${origin.replaceAll('\\', '/').replace(/^(?=[A-Za-z]:)/, '/')}`
    await runGit(seed, [
      '-c',
      'protocol.file.allow=always',
      'push',
      '-q',
      originUrl,
      'HEAD:refs/heads/main'
    ])
    const cloneParent = await mkdtemp(path.join(tmpdir(), 'mechbay-git-partial-'))
    tempDirs.push(cloneParent)
    const clone = path.join(cloneParent, 'clone')
    await execFileAsync('git', [
      '-c',
      'protocol.file.allow=always',
      'clone',
      '-q',
      '--filter=blob:none',
      '-b',
      'main',
      originUrl,
      clone
    ])
    const { stdout } = await execFileAsync('git', ['-C', clone, 'rev-parse', 'HEAD~1'])
    const olderSha = stdout.trim()

    // The mission repoints the promisor remote at ssh, plants an ssh command,
    // and re-allows ssh in the repo's own config.
    const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
    tempDirs.push(markerDir)
    const marker = path.join(markerDir, 'ssh-ran')
    const sshScript = path.join(markerDir, 'fake-ssh.sh')
    await writeFile(sshScript, `#!/bin/sh\necho hit > '${marker.replaceAll('\\', '/')}'\nexit 1\n`)
    await chmod(sshScript, 0o755)
    await runGit(clone, ['remote', 'set-url', 'origin', 'ssh://example.invalid/x'])
    await runGit(clone, ['config', 'core.sshCommand', sshScript.replaceAll('\\', '/')])
    await runGit(clone, ['config', 'protocol.ssh.allow', 'always'])

    await computeDiffSummary(clone, olderSha)
    await readFilePatch(clone, olderSha, 'tracked.txt')

    expect(await exists(marker)).toBe(false)
  }, 60_000)

  it('never runs the empty-name remote helper behind a `::` URL', async () => {
    const repoPath = await makeRepo()
    const helperDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-helper-'))
    tempDirs.push(helperDir)
    const marker = path.join(helperDir, 'helper-ran')
    // `git fetch ::x` asks for a remote helper with an empty name: an
    // executable called `git-remote-` on PATH. Git for Windows runs an
    // extensionless `#!/bin/sh` script through its own sh.
    const helper = path.join(helperDir, 'git-remote-')
    await writeFile(helper, `#!/bin/sh\necho hit > '${marker.replaceAll('\\', '/')}'\nexit 1\n`)
    await chmod(helper, 0o755)
    const fetchWith = (env: NodeJS.ProcessEnv): Promise<unknown> =>
      execFileAsync('git', ['-C', repoPath, 'fetch', '::x'], {
        env: withPathFirst(env, helperDir),
        windowsHide: true
      }).catch(() => undefined)

    // Control: with no allowlist, git does find and run the helper.
    await fetchWith(
      Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'GIT_ALLOW_PROTOCOL')
      )
    )
    expect(await exists(marker)).toBe(true)
    await rm(marker)

    await fetchWith(gitEnv())

    expect(await exists(marker)).toBe(false)
  })
})

/** `env` with `dir` first on PATH, whatever case this platform gives the name. */
function withPathFirst(env: NodeJS.ProcessEnv, dir: string): NodeJS.ProcessEnv {
  const name = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  return { ...env, [name]: dir + path.delimiter + (env[name] ?? '') }
}

/** True when a `.git` entry exists in `dir` or any folder above it. */
function gitEntryAbove(dir: string): boolean {
  for (let current = dir; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, '.git'))) return true
    if (path.dirname(current) === current) return false
  }
}

// A plain temp folder only counts as "no repository" if nothing above the
// temp directory is a repository.
const TMPDIR_INSIDE_A_REPO = gitEntryAbove(tmpdir())

describe('isGitRepository', { timeout: GIT_TEST_TIMEOUT_MS }, () => {
  it('reports a repository without commits as a repository', async () => {
    const empty = await mkdtemp(path.join(tmpdir(), 'mechbay-git-empty-'))
    tempDirs.push(empty)
    await runGit(empty, ['init'])

    await expect(isGitRepository(empty)).resolves.toBe('repo')
  })

  it('reports unknown, not "no repository", when git cannot read the repository', async () => {
    const broken = await mkdtemp(path.join(tmpdir(), 'mechbay-git-broken-'))
    tempDirs.push(broken)
    await runGit(broken, ['init'])
    await writeFile(path.join(broken, '.git', 'config'), '[core\n\tbroken = = =\n')

    await expect(isGitRepository(broken)).resolves.toBe('unknown')
  })

  it.skipIf(TMPDIR_INSIDE_A_REPO)(
    'reports no repository for a folder with no .git in it or above it (skipped when the temp folder sits inside a repo)',
    async () => {
      const plain = await mkdtemp(path.join(tmpdir(), 'mechbay-git-plain-'))
      tempDirs.push(plain)

      await expect(isGitRepository(plain)).resolves.toBe('none')
    }
  )
})

/**
 * A superproject whose submodule `lib` was pinned at lib's first commit in
 * the baseline and has since been checked out at lib's second commit.
 */
async function makeMovedSubmodule(): Promise<{
  app: string
  sub: string
  baselineSha: string | null
}> {
  const lib = await makeRepo()
  const first = await captureGitBaseline(lib)
  await writeFile(path.join(lib, 'other.txt'), 'second commit\n')
  await runGit(lib, ['add', 'other.txt'])
  await runGit(lib, ['commit', '-m', 'second'])
  const second = await captureGitBaseline(lib)

  const app = await makeRepo()
  await execFileAsync('git', [
    '-c',
    'protocol.file.allow=always',
    '-C',
    app,
    'submodule',
    'add',
    '-q',
    lib.replaceAll('\\', '/'),
    'lib'
  ])
  const sub = path.join(app, 'lib')
  await runGit(sub, ['checkout', '-q', first ?? ''])
  await runGit(app, ['add', 'lib'])
  await runGit(app, ['commit', '-m', 'pin lib at its first commit'])
  const baselineSha = await captureGitBaseline(app)
  await runGit(sub, ['checkout', '-q', second ?? ''])
  return { app, sub, baselineSha }
}

/**
 * Defines a repo-local filter driver "evil" that applies to every file and
 * writes a marker when git runs it. Returns the marker path (outside the repo).
 */
async function plantFilter(repoPath: string, kind: 'clean' | 'process'): Promise<string> {
  const markerDir = await mkdtemp(path.join(tmpdir(), 'mechbay-git-markers-'))
  tempDirs.push(markerDir)
  const marker = path.join(markerDir, `${kind}-ran`)
  const shellMarker = marker.replaceAll('\\', '/')
  const infoDir = path.join(await gitDir(repoPath), 'info')
  await mkdir(infoDir, { recursive: true })
  await writeFile(path.join(infoDir, 'attributes'), '* filter=evil\n')
  const command =
    kind === 'clean' ? `echo hit > '${shellMarker}'; cat` : `echo hit > '${shellMarker}'; exit 1`
  await runGit(repoPath, ['config', `filter.evil.${kind}`, command])
  await runGit(repoPath, ['config', 'filter.evil.required', 'true'])
  return marker
}

/**
 * Edits tracked.txt without changing its size or mtime, and backdates the
 * index to the same moment. The entry is then "racily clean", so even
 * `git status` must read the file's content (through any clean filter).
 */
async function racySameSizeEdit(repoPath: string): Promise<void> {
  const file = path.join(repoPath, 'tracked.txt')
  const before = await stat(file)
  // Keep whatever line endings the checkout used, so the size really is unchanged.
  const content = await readFile(file, 'utf8')
  await writeFile(file, content.replace('line two', 'line TWO'))
  await utimes(file, before.atime, before.mtime)
  await utimes(path.join(await gitDir(repoPath), 'index'), before.mtime, before.mtime)
}

/** The repo's real git directory (a submodule's `.git` is only a pointer file). */
async function gitDir(repoPath: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['-C', repoPath, 'rev-parse', '--absolute-git-dir'])
  return path.resolve(stdout.trim())
}
