import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import { FsReader } from '../../src/main/fs-reader'

describe('FsReader — security', () => {
  const root = path.join(os.tmpdir(), 'mechbay-fs-test-' + Date.now())
  const subDir = path.join(root, 'project')
  const secretDir = path.join(root, 'secret')

  beforeEach(() => {
    fs.mkdirSync(subDir, { recursive: true })
    fs.mkdirSync(secretDir, { recursive: true })
    fs.writeFileSync(path.join(subDir, 'safe.txt'), 'safe content')
    fs.writeFileSync(path.join(secretDir, 'oops.txt'), 'secret content')
  })

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('allows reading a file inside a whitelisted path', async () => {
    const reader = new FsReader([subDir])
    const content = await reader.readFile(path.join(subDir, 'safe.txt'))
    expect(content).toBe('safe content')
  })

  it('allows listing a whitelisted directory', async () => {
    const reader = new FsReader([subDir])
    const entries = await reader.readDir(subDir)
    expect(entries.map((e) => e.name)).toContain('safe.txt')
  })

  it('rejects path traversal via .. out of the whitelist', async () => {
    const reader = new FsReader([subDir])
    await expect(reader.readFile(path.join(subDir, '..', 'secret', 'oops.txt'))).rejects.toThrow(
      /access denied/i
    )
  })

  it('rejects absolute paths outside the whitelist', async () => {
    const reader = new FsReader([subDir])
    await expect(reader.readFile(path.join(secretDir, 'oops.txt'))).rejects.toThrow(
      /access denied/i
    )
  })

  it('rejects readDir for a path outside the whitelist', async () => {
    const reader = new FsReader([subDir])
    await expect(reader.readDir(secretDir)).rejects.toThrow(/access denied/i)
  })
})

describe('FsReader — behavior', () => {
  const root = path.join(os.tmpdir(), 'mechbay-fs-behave-' + Date.now())

  beforeEach(() => {
    fs.mkdirSync(root, { recursive: true })
    fs.mkdirSync(path.join(root, 'node_modules'))
    fs.mkdirSync(path.join(root, 'src'))
    fs.writeFileSync(path.join(root, 'package.json'), '{}')
    fs.writeFileSync(path.join(root, 'src', 'app.ts'), 'console.log(1)')
    fs.writeFileSync(path.join(root, 'node_modules', 'junk'), 'x')
  })

  afterEach(() => {
    if (fs.existsSync(root)) fs.rmSync(root, { recursive: true, force: true })
  })

  it('returns directory entries with type + size', async () => {
    const reader = new FsReader([root])
    const entries = await reader.readDir(root)
    const pkg = entries.find((e) => e.name === 'package.json')
    expect(pkg?.type).toBe('file')
    expect(pkg?.size).toBeGreaterThan(0)
    const src = entries.find((e) => e.name === 'src')
    expect(src?.type).toBe('directory')
  })

  it('honors the ignore list (node_modules, .git, etc.)', async () => {
    const reader = new FsReader([root])
    const entries = await reader.readDir(root, { ignore: ['node_modules'] })
    expect(entries.some((e) => e.name === 'node_modules')).toBe(false)
    expect(entries.some((e) => e.name === 'src')).toBe(true)
  })

  it('rejects files exceeding maxBytes', async () => {
    const reader = new FsReader([root])
    const big = path.join(root, 'big.bin')
    fs.writeFileSync(big, Buffer.alloc(2048, 1))
    await expect(reader.readFile(big, 1024)).rejects.toThrow(/too large/i)
  })

  it('updateWhitelist reflects new paths immediately', async () => {
    const reader = new FsReader([])
    await expect(reader.readFile(path.join(root, 'package.json'))).rejects.toThrow(/access denied/i)
    reader.updateWhitelist([root])
    await expect(reader.readFile(path.join(root, 'package.json'))).resolves.toBe('{}')
  })
})
