import { describe, it, expect, beforeEach } from 'vitest'
import fs from 'fs'
import path from 'path'
import os from 'os'
import {
  scaffoldSoulAndMemory,
  assembleSystemPrompt,
  appendMemoryEntry
} from '../../src/main/soul-memory'

describe('soul-memory', () => {
  const tmp = path.join(os.tmpdir(), 'mechbay-soul-test-' + Date.now())

  beforeEach(() => {
    if (fs.existsSync(tmp)) fs.rmSync(tmp, { recursive: true })
    fs.mkdirSync(tmp, { recursive: true })
  })

  it('scaffolds soul.md and memory.md on first run', () => {
    const paths = {
      soulPath: path.join(tmp, 'atlas', 'soul.md'),
      memoryPath: path.join(tmp, 'atlas', 'memory.md')
    }
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    expect(fs.existsSync(paths.soulPath)).toBe(true)
    expect(fs.existsSync(paths.memoryPath)).toBe(true)
    expect(fs.readFileSync(paths.soulPath, 'utf-8')).toContain('Atlas-Prime')
    expect(fs.readFileSync(paths.memoryPath, 'utf-8')).toContain("Atlas-Prime's Memory")
  })

  it('does not overwrite existing soul.md / memory.md', () => {
    const paths = {
      soulPath: path.join(tmp, 'raven', 'soul.md'),
      memoryPath: path.join(tmp, 'raven', 'memory.md')
    }
    scaffoldSoulAndMemory('raven', 'Raven-Prime', paths)
    fs.writeFileSync(paths.soulPath, 'EDITED BY USER')
    scaffoldSoulAndMemory('raven', 'Raven-Prime', paths)

    expect(fs.readFileSync(paths.soulPath, 'utf-8')).toBe('EDITED BY USER')
  })

  it('assembles system prompt with soul + memory + task', () => {
    const paths = {
      soulPath: path.join(tmp, 'atlas', 'soul.md'),
      memoryPath: path.join(tmp, 'atlas', 'memory.md')
    }
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)
    const prompt = assembleSystemPrompt('Atlas-Prime', paths, 'Fix the failing tests.')

    expect(prompt).toContain('Atlas-Prime · Soul')
    expect(prompt).toContain('Atlas-Prime · Memory')
    expect(prompt).toContain('Fix the failing tests.')
    expect(prompt.indexOf('Soul')).toBeLessThan(prompt.indexOf('Memory'))
    expect(prompt.indexOf('Memory')).toBeLessThan(prompt.indexOf('Current Task'))
  })

  it('throws a clear error if soul/memory paths do not exist', () => {
    expect(() =>
      assembleSystemPrompt(
        'Atlas-Prime',
        {
          soulPath: path.join(tmp, 'missing', 'soul.md'),
          memoryPath: path.join(tmp, 'missing', 'memory.md')
        },
        'task'
      )
    ).toThrow(/soul\/memory missing/i)
  })

  it('appends memory entries with timestamp + facility + outcome', () => {
    const paths = {
      soulPath: path.join(tmp, 'atlas', 'soul.md'),
      memoryPath: path.join(tmp, 'atlas', 'memory.md')
    }
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T14:32:00Z'),
      facility: 'sentinel',
      task: 'Fix failing tests',
      outcome: 'Success. Fixed 3 tests.'
    })

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    expect(mem).toContain('2026-04-17')
    expect(mem).toContain('sentinel')
    expect(mem).toContain('Fix failing tests')
    expect(mem).toContain('Fixed 3 tests.')
  })

  it('supports multiple sequential memory appends in chronological order', () => {
    const paths = {
      soulPath: path.join(tmp, 'atlas', 'soul.md'),
      memoryPath: path.join(tmp, 'atlas', 'memory.md')
    }
    scaffoldSoulAndMemory('atlas', 'Atlas-Prime', paths)

    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T10:00:00Z'),
      facility: 'foundry',
      task: 'first',
      outcome: 'ok'
    })
    appendMemoryEntry(paths.memoryPath, {
      timestamp: new Date('2026-04-17T11:00:00Z'),
      facility: 'foundry',
      task: 'second',
      outcome: 'ok'
    })

    const mem = fs.readFileSync(paths.memoryPath, 'utf-8')
    expect(mem.indexOf('first')).toBeLessThan(mem.indexOf('second'))
  })
})
