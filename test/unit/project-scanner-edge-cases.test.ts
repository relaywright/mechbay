import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs/promises'
import fsSync from 'fs'
import os from 'os'
import path from 'path'
import { scanProjects } from '../../src/main/project-scanner'

let tmpRoot: string

describe('scanProjects — edge cases', () => {
  beforeAll(async () => {
    tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'mechbay-scan-edge-'))
  })

  afterAll(async () => {
    if (tmpRoot) await fs.rm(tmpRoot, { recursive: true, force: true })
  })

  it('handles circular symlinks without infinite loop', async () => {
    const projectDir = path.join(tmpRoot, 'circular-project')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'package.json'), '{}')

    // Create circular symlink: project/link -> project
    const linkPath = path.join(projectDir, 'link')
    // On Windows, directory symlinks need special handling
    if (process.platform === 'win32') {
      fsSync.symlinkSync(projectDir, linkPath, 'junction')
    } else {
      fsSync.symlinkSync(projectDir, linkPath, 'dir')
    }

    // Should complete without hanging
    const start = Date.now()
    const found = await scanProjects(tmpRoot, [])
    const elapsed = Date.now() - start

    // Should complete quickly (not stuck in infinite loop)
    expect(elapsed).toBeLessThan(1000)

    // Should find the project (but not infinite entries)
    const project = found.find((p) => p.name === 'circular-project')
    expect(project).toBeDefined()
    expect(project?.markers).toContain('package.json')
  })

  it('handles directory that becomes unreadable mid-scan gracefully', async () => {
    // Create a project directory
    const projectDir = path.join(tmpRoot, 'readable-project')
    await fs.mkdir(projectDir, { recursive: true })
    await fs.writeFile(path.join(projectDir, 'package.json'), '{}')

    // Create another directory that we'll make unreadable
    const unreadableDir = path.join(tmpRoot, 'unreadable-dir')
    await fs.mkdir(unreadableDir, { recursive: true })
    await fs.writeFile(path.join(unreadableDir, 'package.json'), '{}')

    // Skip this test on Windows (permission model is different)
    if (process.platform === 'win32') {
      return
    }

    // Remove read permission
    await fs.chmod(unreadableDir, 0o000)

    try {
      const found = await scanProjects(tmpRoot, [])

      // Should still find the readable project
      expect(found.some((p) => p.name === 'readable-project')).toBe(true)

      // Should not include the unreadable directory (gracefully skipped)
      expect(found.some((p) => p.name === 'unreadable-dir')).toBe(false)
    } finally {
      // Restore permission for cleanup
      await fs.chmod(unreadableDir, 0o755).catch(() => {})
    }
  })

  it('handles deeply nested directory structure (shallow scan only)', async () => {
    const deepDir = path.join(tmpRoot, 'deep', 'nesting', 'levels', 'here')
    await fs.mkdir(deepDir, { recursive: true })
    await fs.writeFile(path.join(deepDir, 'package.json'), '{}')

    // scanProjects is shallow - only scans immediate children of root
    // So deep/nesting/levels/here won't be found as a direct child
    // And 'deep' won't be found because it has no markers in its immediate children
    const found = await scanProjects(tmpRoot, [])

    // 'deep' is not a project (no markers in its immediate children)
    // 'here' is not at the root level
    expect(found.some((p) => p.name === 'deep')).toBe(false)
    expect(found.some((p) => p.name === 'here')).toBe(false)
  })

  it('handles directory names with special characters', async () => {
    const specialNames = [
      'project with spaces',
      'project-with-dashes',
      'project_with_underscores',
      'project.with.dots',
      'UPPERCASE',
      'mixed-Case-Project'
    ]

    for (const name of specialNames) {
      const dir = path.join(tmpRoot, name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'package.json'), '{}')
    }

    const found = await scanProjects(tmpRoot, [])
    const foundNames = found.map((p) => p.name)

    for (const name of specialNames) {
      expect(foundNames).toContain(name)
    }
  })

  it('handles unicode directory names', async () => {
    const unicodeNames = [
      '项目', // Chinese
      'プロジェクト', // Japanese
      '프로젝트', // Korean
      'проект', // Cyrillic
      '🚀rocket-project'
    ]

    for (const name of unicodeNames) {
      const dir = path.join(tmpRoot, name)
      await fs.mkdir(dir, { recursive: true })
      await fs.writeFile(path.join(dir, 'package.json'), '{}')
    }

    const found = await scanProjects(tmpRoot, [])
    const foundNames = found.map((p) => p.name)

    for (const name of unicodeNames) {
      expect(foundNames).toContain(name)
    }
  })

  it('handles empty root directory', async () => {
    const emptyRoot = path.join(tmpRoot, 'empty-root')
    await fs.mkdir(emptyRoot, { recursive: true })

    const found = await scanProjects(emptyRoot, [])
    expect(found).toEqual([])
  })

  it('handles root that is a file instead of directory', async () => {
    const filePath = path.join(tmpRoot, 'not-a-directory')
    await fs.writeFile(filePath, 'content')

    // Should return empty array, not throw
    const found = await scanProjects(filePath, [])
    expect(found).toEqual([])
  })

  it('handles all marker types correctly', async () => {
    const markerProjects = [
      { name: 'git-project', marker: '.git', isDir: true },
      { name: 'node-project', marker: 'package.json', isDir: false },
      { name: 'python-project', marker: 'pyproject.toml', isDir: false },
      { name: 'rust-project', marker: 'Cargo.toml', isDir: false },
      { name: 'go-project', marker: 'go.mod', isDir: false },
      { name: 'java-project', marker: 'pom.xml', isDir: false },
      { name: 'gradle-project', marker: 'build.gradle', isDir: false },
      { name: 'ruby-project', marker: 'Gemfile', isDir: false },
      { name: 'php-project', marker: 'composer.json', isDir: false }
    ]

    for (const { name, marker, isDir } of markerProjects) {
      const dir = path.join(tmpRoot, name)
      await fs.mkdir(dir, { recursive: true })
      if (isDir) {
        await fs.mkdir(path.join(dir, marker), { recursive: true })
      } else {
        await fs.writeFile(path.join(dir, marker), '{}')
      }
    }

    const found = await scanProjects(tmpRoot, [])

    for (const { name, marker } of markerProjects) {
      const project = found.find((p) => p.name === name)
      expect(project).toBeDefined()
      expect(project?.markers).toContain(marker)
    }
  })

  it('handles multiple markers in same project', async () => {
    const multiMarkerDir = path.join(tmpRoot, 'multi-marker')
    await fs.mkdir(multiMarkerDir, { recursive: true })
    await fs.writeFile(path.join(multiMarkerDir, 'package.json'), '{}')
    await fs.mkdir(path.join(multiMarkerDir, '.git'), { recursive: true })
    await fs.writeFile(path.join(multiMarkerDir, 'README.md'), '')

    const found = await scanProjects(tmpRoot, [])
    const project = found.find((p) => p.name === 'multi-marker')

    expect(project).toBeDefined()
    expect(project?.markers.sort()).toEqual(['.git', 'package.json'])
  })

  it('ignores files at root level (not directories)', async () => {
    await fs.writeFile(path.join(tmpRoot, 'package.json'), '{}')
    await fs.writeFile(path.join(tmpRoot, 'Cargo.toml'), '[package]')

    const found = await scanProjects(tmpRoot, [])

    // Files at root should not be treated as projects
    expect(found.some((p) => p.name === 'package.json')).toBe(false)
    expect(found.some((p) => p.name === 'Cargo.toml')).toBe(false)
  })
})
