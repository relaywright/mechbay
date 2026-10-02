import { afterEach, describe, expect, it } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { captureGitBaseline, computeDiffSummary, readFilePatch } from '../../src/main/git-diff'

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
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe('git diff capture', () => {
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

describe('readFilePatch', () => {
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
