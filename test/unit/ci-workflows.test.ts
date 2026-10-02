import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'

const read = (file: string): string => readFileSync(file, 'utf8')

describe('one verification workflow gates pull requests and releases (S6)', () => {
  it('verify.yml is reusable and runs every gate on Node 22, on Linux and Windows', () => {
    const verify = read('.github/workflows/verify.yml')
    expect(verify).toMatch(/on:\s*workflow_call:/)
    for (const step of [
      'npm ci',
      'npm run typecheck',
      'npm run lint -- --max-warnings 0',
      'npm test',
      'npx electron-vite build'
    ]) {
      expect(verify).toContain(step)
    }
    expect(verify).toContain('node-version: 22')
    expect(verify).toContain('os: [ubuntu-latest, windows-latest]')
  })

  it('CI calls it', () => {
    expect(read('.github/workflows/ci.yml')).toContain('uses: ./.github/workflows/verify.yml')
  })

  it('a release cannot build or publish before it passes, and has no private gate list', () => {
    const release = read('.github/workflows/release.yml')
    expect(release).toContain('uses: ./.github/workflows/verify.yml')
    expect(release).toMatch(/build:\s*needs: verify/)
    expect(release).not.toMatch(/npm run typecheck|npm test/)
  })

  it('typecheck covers the tests', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> }
    expect(pkg.scripts.typecheck).toContain('typecheck:test')
  })
})
