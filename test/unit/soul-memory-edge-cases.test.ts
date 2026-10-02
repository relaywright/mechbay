import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  scaffoldSoulAndMemory,
  assembleSystemPrompt,
  appendMemoryEntry
} from '../../src/main/soul-memory'

describe('soul-memory — edge cases', () => {
  const tmp = path.join(os.tmpdir(), 'mechbay-soul-edge-' + Date.now())

  beforeEach(() => {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true })
    fs.mkdirSync(tmp, { recursive: true })
  })

  it('handles paths with special characters', () => {
    const specialPath = path.join(tmp, 'project with spaces', 'nested-dir')
    const paths = {
      soulPath: path.join(specialPath, 'soul.md'),
      memoryPath: path.join(specialPath, 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    expect(fs.existsSync(paths.soulPath)).toBe(true)
    expect(fs.existsSync(paths.memoryPath)).toBe(true)
    expect(fs.readFileSync(paths.soulPath, 'utf-8')).toContain('Atlas-Prime')
  })

  it('handles deeply nested paths', () => {
    const deepPath = path.join(tmp, 'a', 'b', 'c', 'd', 'e', 'f')
    const paths = {
      soulPath: path.join(deepPath, 'soul.md'),
      memoryPath: path.join(deepPath, 'memory.md')
    }

    scaffoldSoulAndMemory('raven', 'Raven-Prime', paths)

    expect(fs.existsSync(paths.soulPath)).toBe(true)
    expect(fs.existsSync(paths.memoryPath)).toBe(true)
  })

  it('preserves existing files even with different mech class', () => {
    const paths = {
      soulPath: path.join(tmp, 'companion', 'soul.md'),
      memoryPath: path.join(tmp, 'companion', 'memory.md')
    }

    // First scaffold as atlas
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)
    const originalSoul = fs.readFileSync(paths.soulPath, 'utf-8')
    const originalMemory = fs.readFileSync(paths.memoryPath, 'utf-8')

    // Second scaffold as raven (different class) - should not overwrite
    scaffoldSoulAndMemory('raven', 'Raven-Prime', paths)

    expect(fs.readFileSync(paths.soulPath, 'utf-8')).toBe(originalSoul)
    expect(fs.readFileSync(paths.memoryPath, 'utf-8')).toBe(originalMemory)
  })

  it('handles empty string content in existing files', () => {
    const paths = {
      soulPath: path.join(tmp, 'empty', 'soul.md'),
      memoryPath: path.join(tmp, 'empty', 'memory.md')
    }

    fs.mkdirSync(path.dirname(paths.soulPath), { recursive: true })
    fs.writeFileSync(paths.soulPath, '')
    fs.writeFileSync(paths.memoryPath, '')

    // Should not overwrite even if empty
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    expect(fs.readFileSync(paths.soulPath, 'utf-8')).toBe('')
    expect(fs.readFileSync(paths.memoryPath, 'utf-8')).toBe('')
  })

  it('handles unicode content in memory entries', () => {
    const paths = {
      soulPath: path.join(tmp, 'unicode', 'soul.md'),
      memoryPath: path.join(tmp, 'unicode', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T10:00:00Z'),
      facility: '研究实验室', // Chinese
      task: 'テストを修正', // Japanese
      outcome: '성공! 🎉' // Korean + emoji
    })

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    expect(mem).toContain('研究实验室')
    expect(mem).toContain('テストを修正')
    expect(mem).toContain('성공! 🎉')
  })

  it('handles very long task/outcome strings', () => {
    const paths = {
      soulPath: path.join(tmp, 'long', 'soul.md'),
      memoryPath: path.join(tmp, 'long', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    const longTask = 'a'.repeat(1000)
    const longOutcome = 'b'.repeat(5000)

    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T10:00:00Z'),
      facility: 'foundry',
      task: longTask,
      outcome: longOutcome
    })

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    expect(mem).toContain(longTask)
    expect(mem).toContain(longOutcome)
  })

  it('handles newlines in task and outcome', () => {
    const paths = {
      soulPath: path.join(tmp, 'multiline', 'soul.md'),
      memoryPath: path.join(tmp, 'multiline', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T10:00:00Z'),
      facility: 'foundry',
      task: 'Line 1\nLine 2\nLine 3',
      outcome: 'Result A\nResult B'
    })

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    expect(mem).toContain('Line 1')
    expect(mem).toContain('Line 2')
    expect(mem).toContain('Line 3')
    expect(mem).toContain('Result A')
    expect(mem).toContain('Result B')
  })

  it('handles assembleSystemPrompt with very long task prompt', () => {
    const paths = {
      soulPath: path.join(tmp, 'longtask', 'soul.md'),
      memoryPath: path.join(tmp, 'longtask', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    const longPrompt = 'Task: ' + 'x'.repeat(10000)
    const prompt = assembleSystemPrompt('Atlas-Prime', paths, longPrompt)

    expect(prompt).toContain(longPrompt)
    expect(prompt).toContain('Atlas-Prime · Soul')
    expect(prompt).toContain('Atlas-Prime · Memory')
  })

  it('throws clear error for non-existent soul path', () => {
    const paths = {
      soulPath: path.join(tmp, 'missing', 'soul.md'),
      memoryPath: path.join(tmp, 'missing', 'memory.md')
    }

    // Create only memory file
    fs.mkdirSync(path.dirname(paths.memoryPath), { recursive: true })
    fs.writeFileSync(paths.memoryPath, 'memory content')

    expect(() => assembleSystemPrompt('Test', paths, 'task')).toThrow(/soul\/memory missing/i)
  })

  it('throws clear error for non-existent memory path', () => {
    const paths = {
      soulPath: path.join(tmp, 'missing2', 'soul.md'),
      memoryPath: path.join(tmp, 'missing2', 'memory.md')
    }

    // Create only soul file
    fs.mkdirSync(path.dirname(paths.soulPath), { recursive: true })
    fs.writeFileSync(paths.soulPath, 'soul content')

    expect(() => assembleSystemPrompt('Test', paths, 'task')).toThrow(/soul\/memory missing/i)
  })

  it('handles multiple rapid memory appends', () => {
    const paths = {
      soulPath: path.join(tmp, 'rapid', 'soul.md'),
      memoryPath: path.join(tmp, 'rapid', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    // Append 10 entries rapidly
    for (let i = 0; i < 10; i++) {
      appendMemoryEntry(paths.memoryPath, {
        timestamp: new Date(`2026-04-17T${String(i).padStart(2, '0')}:00:00Z`),
        facility: 'foundry',
        task: `Task ${i}`,
        outcome: `Outcome ${i}`
      })
    }

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')

    // All entries should be present in order
    for (let i = 0; i < 10; i++) {
      expect(mem).toContain(`Task ${i}`)
      expect(mem).toContain(`Outcome ${i}`)
    }

    // Check chronological order
    let lastIndex = -1
    for (let i = 0; i < 10; i++) {
      const idx = mem.indexOf(`Task ${i}`)
      expect(idx).toBeGreaterThan(lastIndex)
      lastIndex = idx
    }
  })

  it('handles special characters in facility names', () => {
    const paths = {
      soulPath: path.join(tmp, 'special-facility', 'soul.md'),
      memoryPath: path.join(tmp, 'special-facility', 'memory.md')
    }

    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    const specialFacilities = [
      'Facility [1]',
      'Facility (test)',
      'Facility "quoted"',
      "Facility 'single'",
      'Facility <tag>',
      'Facility & more'
    ]

    for (const facility of specialFacilities) {
      appendMemoryEntry(paths.memoryPath, {
        timestamp: new Date(),
        facility,
        task: 'test',
        outcome: 'ok'
      })
    }

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    for (const facility of specialFacilities) {
      expect(mem).toContain(facility)
    }
  })
})
