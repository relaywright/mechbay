import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * Opening a diff must never run a program the repository configured
 * (an fsmonitor hook, a hook, a textconv driver or a clean/process filter
 * in .git/config). Every git call MechBay makes therefore carries the same
 * safe global options (no optional locks, fsmonitor off, no transports,
 * hooks pointed at a folder that does not exist) and a sanitized
 * environment, plus blanking options for each filter driver the repo
 * defines. Diffs carry `--no-ext-diff --no-textconv`, and status/diff never
 * look inside a submodule's working tree. execFile is mocked so the exact
 * argv and env can be asserted; the real-repo marker tests live in
 * git-diff.test.ts.
 */

const gitCalls: string[][] = []
const gitEnvs: NodeJS.ProcessEnv[] = []
let configOutput = ''
let configExitCode = 0
let worktreeOutput: string | null = null
let toplevelOutput = ''
let worktreeExitCode = 1

vi.mock('node:child_process', () => ({
  execFile: vi.fn(
    (
      _file: string,
      args: string[],
      options: { env?: NodeJS.ProcessEnv },
      callback: (
        err: (Error & { code?: number; stdout?: string }) | null,
        result?: { stdout: string; stderr: string }
      ) => void
    ) => {
      gitCalls.push(args)
      gitEnvs.push(options.env ?? {})
      if (args.includes('core.worktree')) {
        if (worktreeOutput === null) {
          callback(
            Object.assign(new Error('git config failed'), { code: worktreeExitCode, stdout: '' })
          )
          return
        }
        callback(null, { stdout: worktreeOutput, stderr: '' })
        return
      }
      if (args.includes('--show-toplevel')) {
        callback(null, { stdout: toplevelOutput, stderr: '' })
        return
      }
      if (args.includes('config')) {
        if (configExitCode !== 0) {
          callback(
            Object.assign(new Error('git config failed'), { code: configExitCode, stdout: '' })
          )
          return
        }
        callback(null, { stdout: configOutput, stderr: '' })
        return
      }
      callback(null, { stdout: '', stderr: '' })
    }
  )
}))

import {
  captureGitBaseline,
  computeDiffSummary,
  filterOverridesFromConfig,
  isGitRepository,
  readFilePatch
} from '../../src/main/git-diff'

const BASELINE = 'a'.repeat(40)
const HOOKS_OFF = expect.stringMatching(/^core\.hooksPath=.*mechbay-no-hooks-[0-9a-f-]{36}$/)
const SAFE = [
  '--no-optional-locks',
  '-c',
  'core.fsmonitor=false',
  '-c',
  'protocol.allow=never',
  '-c',
  HOOKS_OFF
]
const BLANK_EVIL = [
  '-c',
  'filter.evil.clean=',
  '-c',
  'filter.evil.smudge=',
  '-c',
  'filter.evil.process=',
  '-c',
  'filter.evil.required=false'
]
let repoPath: string

function configQuery(): string[] {
  return [
    ...SAFE,
    '-C',
    repoPath,
    'config',
    '--includes',
    '--show-scope',
    '--name-only',
    '--get-regexp',
    '^(filter|lfs)\\.'
  ]
}

function worktreeQuery(): string[] {
  return [...SAFE, '-C', repoPath, 'config', '--get', 'core.worktree']
}

/** The guard every diff runs first: the worktree check, then the filter lookup. */
function guard(): string[][] {
  return [worktreeQuery(), configQuery()]
}

beforeEach(async () => {
  gitCalls.length = 0
  gitEnvs.length = 0
  configOutput = 'local\tfilter.evil.clean\nsystem\tfilter.lfs.clean\nsystem\tfilter.lfs.process\n'
  configExitCode = 0
  worktreeOutput = null
  worktreeExitCode = 1
  toplevelOutput = ''
  repoPath = await mkdtemp(path.join(tmpdir(), 'mechbay-git-no-helpers-'))
})

afterEach(async () => {
  await rm(repoPath, { recursive: true, force: true })
})

describe('git calls never run repository-configured programs', () => {
  it('blanks repo filters and disables fsmonitor, textconv and submodules on numstat and status', async () => {
    await computeDiffSummary(repoPath, BASELINE)

    expect(gitCalls).toEqual([
      ...guard(),
      [
        ...SAFE,
        ...BLANK_EVIL,
        '-C',
        repoPath,
        'diff',
        '--numstat',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=dirty',
        '--submodule=short',
        BASELINE
      ],
      [
        ...SAFE,
        ...BLANK_EVIL,
        '-C',
        repoPath,
        'status',
        '--porcelain',
        '-uall',
        '--ignore-submodules=dirty'
      ]
    ])
  })

  it('blanks repo filters and disables fsmonitor, textconv and submodules on the per-file diff', async () => {
    await readFilePatch(repoPath, BASELINE, 'src/app.ts')

    expect(gitCalls).toEqual([
      ...guard(),
      [
        ...SAFE,
        ...BLANK_EVIL,
        '-C',
        repoPath,
        'status',
        '--porcelain',
        '-uall',
        '--ignore-submodules=dirty',
        '--',
        'src/app.ts'
      ],
      [
        ...SAFE,
        ...BLANK_EVIL,
        '-C',
        repoPath,
        'diff',
        '--no-color',
        '--no-ext-diff',
        '--no-textconv',
        '--ignore-submodules=dirty',
        '--submodule=short',
        '--unified=3',
        BASELINE,
        '--',
        'src/app.ts'
      ]
    ])
  })

  it('protects the repository probe for a repo without a baseline', async () => {
    await computeDiffSummary(repoPath, null)

    expect(gitCalls).toEqual([
      ...guard(),
      [...SAFE, ...BLANK_EVIL, '-C', repoPath, 'rev-parse', '--is-inside-work-tree']
    ])
  })

  it('adds no filter options when the config query finds no drivers (exit 1)', async () => {
    configOutput = ''
    configExitCode = 1

    await computeDiffSummary(repoPath, null)

    expect(gitCalls[2]).toEqual([...SAFE, '-C', repoPath, 'rev-parse', '--is-inside-work-tree'])
  })

  it('runs no further git command when the config query fails', async () => {
    configExitCode = 3

    await expect(computeDiffSummary(repoPath, BASELINE)).resolves.toBeNull()
    await expect(readFilePatch(repoPath, BASELINE, 'src/app.ts')).resolves.toBeNull()
    expect(gitCalls).toEqual([...guard(), ...guard()])
  })

  it('runs no further git command when a repo driver name is unsafe to pass with -c', async () => {
    configOutput = 'local\tfilter.a=b.clean\n'

    await expect(computeDiffSummary(repoPath, BASELINE)).resolves.toBeNull()
    await expect(readFilePatch(repoPath, BASELINE, 'src/app.ts')).resolves.toBeNull()
    expect(gitCalls).toEqual([...guard(), ...guard()])
  })

  it('blanks the trusted Git LFS filter when the repo defines LFS extension commands', async () => {
    // The system LFS filter would run lfs.extension.*.clean from the repo's config.
    configOutput =
      'system\tfilter.lfs.clean\nsystem\tfilter.lfs.process\nlocal\tlfs.extension.foo.clean\n'

    await readFilePatch(repoPath, BASELINE, 'src/app.ts')

    const blankLfs = [
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false'
    ]
    expect(gitCalls.slice(2)).toHaveLength(2)
    for (const args of gitCalls.slice(2)) {
      expect(args.slice(0, SAFE.length + blankLfs.length)).toEqual([...SAFE, ...blankLfs])
    }
  })
})

describe('the repository must not redirect git to another working folder', () => {
  it('runs no further git command when core.worktree points outside the project', async () => {
    const outside = await mkdtemp(path.join(tmpdir(), 'mechbay-git-outside-'))
    try {
      worktreeOutput = `${outside}\n`
      toplevelOutput = `${outside.replaceAll('\\', '/')}\n`

      await expect(computeDiffSummary(repoPath, BASELINE)).resolves.toBeNull()
      await expect(readFilePatch(repoPath, BASELINE, 'src/app.ts')).resolves.toBeNull()
      const toplevelQuery = [...SAFE, '-C', repoPath, 'rev-parse', '--show-toplevel']
      expect(gitCalls).toEqual([worktreeQuery(), toplevelQuery, worktreeQuery(), toplevelQuery])
    } finally {
      await rm(outside, { recursive: true, force: true })
    }
  })

  it('continues when core.worktree names the project folder itself (a submodule checkout)', async () => {
    worktreeOutput = '../../../lib\n'
    // git prints forward slashes; Windows paths also compare case-insensitively.
    const sameFolder = repoPath.replaceAll('\\', '/')
    toplevelOutput = `${process.platform === 'win32' ? sameFolder.toUpperCase() : sameFolder}\n`

    await computeDiffSummary(repoPath, null)

    expect(gitCalls.slice(0, 3)).toEqual([
      worktreeQuery(),
      [...SAFE, '-C', repoPath, 'rev-parse', '--show-toplevel'],
      configQuery()
    ])
    expect(gitCalls).toHaveLength(4)
  })

  it('runs no further git command when the core.worktree lookup fails', async () => {
    worktreeExitCode = 3

    await expect(computeDiffSummary(repoPath, BASELINE)).resolves.toBeNull()
    await expect(readFilePatch(repoPath, BASELINE, 'src/app.ts')).resolves.toBeNull()
    expect(gitCalls).toEqual([worktreeQuery(), worktreeQuery()])
  })
})

describe('one hardened way to run git', () => {
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  it('gives the baseline capture the same safe options', async () => {
    await captureGitBaseline(repoPath)

    expect(gitCalls).toEqual([[...SAFE, '-C', repoPath, 'rev-parse', 'HEAD']])
  })

  it('gives the repository check the same safe options and nothing else', async () => {
    await expect(isGitRepository(repoPath)).resolves.toBe('none')

    expect(gitCalls).toEqual([[...SAFE, '-C', repoPath, 'rev-parse', '--is-inside-work-tree']])
  })

  it('points core.hooksPath at one folder that does not exist', async () => {
    await computeDiffSummary(repoPath, BASELINE)
    await captureGitBaseline(repoPath)

    const hooksOptions = gitCalls.map((args) => args.find((a) => a.startsWith('core.hooksPath=')))
    expect(new Set(hooksOptions).size).toBe(1)
    const hooksDir = hooksOptions[0]?.slice('core.hooksPath='.length) ?? ''
    expect(path.isAbsolute(hooksDir)).toBe(true)
    expect(existsSync(hooksDir)).toBe(false)
  })

  it('runs every git child with a sanitized environment', async () => {
    vi.stubEnv('GIT_DIR', '/elsewhere/.git')
    vi.stubEnv('GIT_WORK_TREE', '/elsewhere')
    vi.stubEnv('GIT_CONFIG', '/elsewhere/config')
    vi.stubEnv('Git_Index_File', '/elsewhere/index')
    vi.stubEnv('GIT_CONFIG_GLOBAL', '/home/me/.gitconfig')
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1')
    vi.stubEnv('GIT_ALLOW_PROTOCOL', 'ssh:https')
    vi.stubEnv('MECHBAY_UNRELATED', 'kept')

    await computeDiffSummary(repoPath, BASELINE)
    await readFilePatch(repoPath, BASELINE, 'src/app.ts')
    await captureGitBaseline(repoPath)

    expect(gitEnvs).toHaveLength(gitCalls.length)
    for (const env of gitEnvs) {
      const gitNames = Object.keys(env)
        .filter((name) => name.toUpperCase().startsWith('GIT_'))
        .sort()
      expect(gitNames).toEqual([
        'GIT_ALLOW_PROTOCOL',
        'GIT_CONFIG_GLOBAL',
        'GIT_CONFIG_NOSYSTEM',
        'GIT_NO_LAZY_FETCH',
        'GIT_OPTIONAL_LOCKS',
        'GIT_TERMINAL_PROMPT'
      ])
      expect(env).toMatchObject({
        // An allowlist that repo config (protocol.<name>.allow) cannot widen.
        // '0' is a name no `<name>::` URL can carry; see gitEnv in git-diff.ts.
        GIT_ALLOW_PROTOCOL: '0',
        GIT_CONFIG_GLOBAL: '/home/me/.gitconfig',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_NO_LAZY_FETCH: '1',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_TERMINAL_PROMPT: '0',
        MECHBAY_UNRELATED: 'kept'
      })
    }
  })
})

describe('filterOverridesFromConfig', () => {
  it('blanks drivers defined in the repo and leaves global and system ones alone', () => {
    const output = [
      'global\tfilter.lfs.clean',
      'global\tfilter.lfs.smudge',
      'system\tfilter.sys.clean',
      'local\tfilter.evil.process',
      'local\tfilter.evil.required'
    ].join('\n')

    expect(filterOverridesFromConfig(output)).toEqual(BLANK_EVIL)
  })

  it('blanks a trusted driver that the repo redefines', () => {
    const output = 'global\tfilter.lfs.clean\nlocal\tfilter.lfs.clean\n'

    expect(filterOverridesFromConfig(output)).toEqual([
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false'
    ])
  })

  it('blanks worktree, command and unknown scopes, and keeps dotted driver names whole', () => {
    const output = [
      'worktree\tfilter.a.b.clean',
      'command\tfilter.Cmd.smudge',
      'mystery\tfilter.odd.process'
    ].join('\r\n')

    const overrides = filterOverridesFromConfig(output)

    expect(overrides).toContain('filter.a.b.clean=')
    expect(overrides).toContain('filter.Cmd.process=')
    expect(overrides).toContain('filter.odd.required=false')
    expect(overrides).toHaveLength(24)
  })

  it('returns an empty list when nothing is configured', () => {
    expect(filterOverridesFromConfig('')).toEqual([])
  })

  it('blanks the LFS driver when the repo defines an LFS extension, in any letter case', () => {
    const blankLfs = [
      '-c',
      'filter.lfs.clean=',
      '-c',
      'filter.lfs.smudge=',
      '-c',
      'filter.lfs.process=',
      '-c',
      'filter.lfs.required=false'
    ]

    expect(filterOverridesFromConfig('local\tlfs.extension.foo.clean')).toEqual(blankLfs)
    expect(filterOverridesFromConfig('worktree\tlfs.Extension.Foo.smudge')).toEqual(blankLfs)
    expect(
      filterOverridesFromConfig('local\tlfs.extension.a.clean\nlocal\tlfs.extension.b.smudge')
    ).toEqual(blankLfs)
  })

  it('ignores other LFS settings and LFS extensions from global or system config', () => {
    const output = [
      'local\tlfs.url',
      'local\tlfs.fetchinclude',
      'global\tlfs.extension.mine.clean',
      'system\tlfs.extension.corp.smudge',
      'system\tfilter.lfs.clean'
    ].join('\n')

    expect(filterOverridesFromConfig(output)).toEqual([])
  })

  it.each([
    ['a driver name containing "="', 'local\tfilter.a=b.clean'],
    ['an empty driver name', 'local\tfilter..clean'],
    ['a key without a driver name', 'local\tfilter.clean'],
    ['a line without a scope', 'filter.evil.clean'],
    ['an LFS line without a scope', 'lfs.extension.foo.clean'],
    ['a key from an unexpected section', 'local\tcore.editor']
  ])('fails closed on %s', (_label, output) => {
    expect(filterOverridesFromConfig(output)).toBeNull()
  })
})
