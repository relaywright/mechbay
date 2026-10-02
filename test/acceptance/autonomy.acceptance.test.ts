import { execFileSync } from 'child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterAll, describe, expect, it } from 'vitest'
import { ClaudeRunner } from '../../src/main/runners/claude'
import { CodexRunner } from '../../src/main/runners/codex'
import type { SpawnResult } from '../../src/main/runners/types'

/**
 * Real CLIs, real network, a few cents of usage. Not part of `npm test`;
 * run with `npm run test:real-cli` (Track B done criteria: Autonomy and
 * first readable line). Both CLIs run on clean profiles so the user's own
 * settings, allow rules and hooks cannot change the result.
 */
const REAL = process.env.MECHBAY_REAL_CLI === '1'
const TASK =
  'Append the line "third line" to hello.txt. Then run `npm test` once. Report what happened in one sentence.'
const repos: string[] = []

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'mechbay-accept-'))
  repos.push(dir)
  writeFileSync(path.join(dir, 'hello.txt'), 'first line\nsecond line\n')
  writeFileSync(
    path.join(dir, 'package.json'),
    JSON.stringify(
      {
        name: 'accept',
        private: true,
        scripts: { test: "node -e \"require('fs').writeFileSync('test-ran.txt','yes')\"" }
      },
      null,
      2
    )
  )
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: 'ignore' })
  }
  git('init', '-q')
  git('add', '.')
  git(
    '-c',
    'user.email=accept@mechbay.local',
    '-c',
    'user.name=MechBay Acceptance',
    'commit',
    '-q',
    '-m',
    'init'
  )
  return dir
}

async function drain(
  result: SpawnResult,
  startedAt: number
): Promise<{ out: string; firstLineMs: number | null; code: number }> {
  let out = ''
  let firstLineMs: number | null = null
  for await (const chunk of result.stream) {
    if (chunk.stream === 'stdout' && firstLineMs === null && chunk.text.trim()) {
      firstLineMs = Date.now() - startedAt
    }
    out += chunk.text
  }
  return { out, firstLineMs, code: await result.exit }
}

afterAll(() => {
  for (const dir of repos) {
    rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
  }
})

describe.runIf(REAL)('Autonomy on real CLIs (Track B done criteria)', () => {
  it('Claude at Edit files edits the file, is denied the test command, and shows its first line within 5 seconds', async () => {
    const repo = makeRepo()
    const runner = new ClaudeRunner({ profileArgs: ['--setting-sources', 'project,local'] })
    const startedAt = Date.now()
    const result = await runner.spawn(repo, TASK, { autonomy: 'edit' })
    const { out, firstLineMs } = await drain(result, startedAt)
    console.log(out)
    console.log(`[acceptance] Claude first readable line after ${firstLineMs} ms`)

    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toContain('third line')
    expect(existsSync(path.join(repo, 'test-ran.txt'))).toBe(false)
    expect(out).toMatch(/DENIED · (Bash|PowerShell)\b.*npm (run )?test/)
    expect(result.report?.().permissionDenials.length).toBeGreaterThan(0)
    expect(firstLineMs).not.toBeNull()
    expect(firstLineMs!).toBeLessThan(5000)
  }, 240_000)

  it('Codex at Edit files edits the file and runs the test command inside its sandbox', async () => {
    const repo = makeRepo()
    const env: Record<string, string> = {}
    if (process.platform === 'win32') {
      // Codex must find the regular PowerShell 7 before the Microsoft Store copy its sandbox cannot start.
      const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
      env[key] = `C:\\Program Files\\PowerShell\\7;${process.env[key] ?? ''}`
    }
    const runner = new CodexRunner({ profileArgs: ['--ignore-user-config', '--ignore-rules'] })
    const result = await runner.spawn(repo, TASK, { autonomy: 'edit', env })
    const { out } = await drain(result, Date.now())
    console.log(out)

    expect(readFileSync(path.join(repo, 'hello.txt'), 'utf8')).toContain('third line')
    expect(existsSync(path.join(repo, 'test-ran.txt'))).toBe(true)
  }, 300_000)
})
