import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync
} from 'fs'
import * as realFs from 'fs'
import { tmpdir } from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LogStore, isValidMissionId, logDirFor, prepareLogStore } from '../../src/main/log-store'
import type { LogChunk } from '../../src/shared/types'

const ID = '01J9Z1D0EP000000000000005'

describe('LogStore', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), 'mechbay-logs-'))
  })
  afterEach(() => {
    vi.useRealTimers()
    rmSync(dir, { recursive: true, force: true })
  })

  const countingFs = (): {
    fs: typeof realFs
    appendFileSync: ReturnType<typeof vi.fn<typeof realFs.appendFileSync>>
  } => {
    const appendFileSync = vi.fn(realFs.appendFileSync)
    return { fs: { ...realFs, appendFileSync }, appendFileSync }
  }

  it('batches a 1000-line burst into 20 disk writes and keeps every line', async () => {
    const { fs, appendFileSync } = countingFs()
    const store = new LogStore({ dir, fs })
    for (let i = 1; i <= 1000; i++) store.append(ID, { stream: 'stdout', text: `line ${i}` })
    store.close(ID)
    expect(appendFileSync).toHaveBeenCalledTimes(20)
    const history = await store.history(ID)
    expect(history).toHaveLength(1000)
    expect(history[0]).toMatchObject({ id: `${ID}:1`, seq: 1, text: 'line 1' })
    expect(history[999]).toMatchObject({ seq: 1000, text: 'line 1000' })
  })

  it('flushes a quiet mission after 200 ms', () => {
    vi.useFakeTimers()
    const { fs, appendFileSync } = countingFs()
    const store = new LogStore({ dir, fs })
    store.append(ID, { stream: 'stdout', text: 'only line' })
    expect(appendFileSync).not.toHaveBeenCalled()
    vi.advanceTimersByTime(200)
    expect(appendFileSync).toHaveBeenCalledOnce()
  })

  it('hands each flushed batch to onEntries for the live view', () => {
    const batches: LogChunk[][] = []
    const store = new LogStore({ dir, onEntries: (entries) => batches.push(entries) })
    for (let i = 0; i < 120; i++) store.append(ID, { stream: 'stdout', text: String(i) })
    store.close(ID)
    expect(batches.map((b) => b.length)).toEqual([50, 50, 20])
  })

  it('replays a mission after a restart and continues its numbering', async () => {
    const first = new LogStore({ dir })
    first.append(ID, { stream: 'stdout', text: 'before restart' })
    first.close(ID)
    const second = new LogStore({ dir })
    second.append(ID, { stream: 'system', text: 'after restart' })
    second.close(ID)
    const history = await second.history(ID)
    expect(history.map((e) => [e.seq, e.text])).toEqual([
      [1, 'before restart'],
      [2, 'after restart']
    ])
    expect((await second.history(ID, 1)).map((e) => e.text)).toEqual(['after restart'])
  })

  it('includes lines still waiting to be written', async () => {
    const store = new LogStore({ dir })
    store.append(ID, { stream: 'stdout', text: 'not flushed yet' })
    expect((await store.history(ID)).map((e) => e.text)).toEqual(['not flushed yet'])
    store.close(ID)
  })

  it('keeps the mission running when the disk is full and warns exactly once', () => {
    const batches: LogChunk[][] = []
    const failing = {
      ...realFs,
      appendFileSync: vi.fn(() => {
        throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' })
      })
    }
    const store = new LogStore({ dir, fs: failing, onEntries: (entries) => batches.push(entries) })
    expect(() => {
      for (let i = 0; i < 200; i++) store.append(ID, { stream: 'stdout', text: String(i) })
      store.close(ID)
    }).not.toThrow()
    const warnings = batches.flat().filter((e) => e.text.startsWith('LOG NOT SAVED'))
    expect(warnings).toHaveLength(1)
    expect(warnings[0].text).toContain('ENOSPC')
    expect(warnings[0].text).not.toContain('\u2014')
    expect(failing.appendFileSync).toHaveBeenCalledOnce()
    expect(batches.flat().filter((e) => e.stream === 'stdout')).toHaveLength(200)
  })

  it('keeps the mission running when its saved log cannot be read, and warns once', () => {
    const batches: LogChunk[][] = []
    const locked = {
      ...realFs,
      existsSync: () => true,
      readFileSync: vi.fn(() => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      })
    }
    const store = new LogStore({ dir, fs: locked, onEntries: (entries) => batches.push(entries) })
    expect(() => {
      store.append(ID, { stream: 'stdout', text: 'still running' })
      store.close(ID)
    }).not.toThrow()
    const texts = batches.flat().map((e) => e.text)
    expect(texts.filter((t) => t.startsWith('LOG NOT SAVED'))).toHaveLength(1)
    expect(texts.some((t) => t.includes('EBUSY'))).toBe(true)
    expect(texts).toContain('still running')
    expect(readdirSync(dir)).toEqual([])
  })

  it.each([
    '..\\..\\mechbay-secrets',
    '../secrets',
    'a/b',
    'C:\\Windows\\win',
    '',
    'x'.repeat(65),
    'id with space'
  ])('rejects mission ids that could leave the log folder: %s', async (bad) => {
    const store = new LogStore({ dir })
    await expect(store.history(bad)).rejects.toThrow('Invalid mission id')
    expect(() => store.append(bad, { stream: 'stdout', text: 'x' })).toThrow('Invalid mission id')
    expect(readdirSync(dir)).toEqual([])
  })

  it.each(['CON', 'nul', 'Aux', 'PRN', 'COM1', 'lpt9', 'CONIN$'])(
    'rejects Windows device names as mission ids: %s',
    async (device) => {
      expect(isValidMissionId(device)).toBe(false)
      await expect(new LogStore({ dir }).history(device)).rejects.toThrow('Invalid mission id')
    }
  )

  it.each([null, undefined, 42, { toString: () => ID }])(
    'rejects a mission id that is not a string: %s',
    async (bad) => {
      expect(isValidMissionId(bad as never)).toBe(false)
      await expect(new LogStore({ dir }).history(bad as never)).rejects.toThrow(
        'Invalid mission id'
      )
    }
  )

  it('stops saving at the per-mission cap with one marker line', async () => {
    const store = new LogStore({ dir, maxLinesPerMission: 10, historyLimit: 50 })
    for (let i = 1; i <= 25; i++) store.append(ID, { stream: 'stdout', text: `l${i}` })
    store.close(ID)
    const saved = readFileSync(path.join(dir, `${ID}.jsonl`), 'utf8')
      .trim()
      .split('\n')
    expect(saved).toHaveLength(11)
    expect(JSON.parse(saved[10]).text).toMatch(/^LOG TRUNCATED · /)
  })

  it('shortens a single huge line instead of saving all of it', async () => {
    const store = new LogStore({ dir })
    store.append(ID, { stream: 'stdout', text: 'x'.repeat(100_000) })
    store.close(ID)
    const [entry] = await store.history(ID)
    expect(entry.text.length).toBeLessThan(17_000)
    expect(entry.text.endsWith('[line shortened]')).toBe(true)
  })

  it('never splits an emoji when shortening a line', async () => {
    const store = new LogStore({ dir })
    // 16,383 single characters put the cut between the two halves of the emoji.
    store.append(ID, { stream: 'stdout', text: 'a'.repeat(16_383) + '\u{1F916}'.repeat(10) })
    store.close(ID)
    const [entry] = await store.history(ID)
    expect(entry.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
  })

  it('starts a new line after a saved log that was cut off mid-write', async () => {
    const file = path.join(dir, `${ID}.jsonl`)
    const first = {
      id: `${ID}:1`,
      deploymentId: ID,
      seq: 1,
      timestamp: 1,
      stream: 'stdout',
      text: 'a'
    }
    writeFileSync(file, JSON.stringify(first) + '\n{"id":"cut')
    const store = new LogStore({ dir })
    store.append(ID, { stream: 'stdout', text: 'after restart' })
    store.close(ID)
    expect((await store.history(ID)).map((e) => e.text)).toEqual(['a', 'after restart'])
  })

  it('returns only the newest entries when a mission is long', async () => {
    const store = new LogStore({ dir, historyLimit: 3 })
    for (let i = 1; i <= 10; i++) store.append(ID, { stream: 'stdout', text: `l${i}` })
    store.close(ID)
    expect((await store.history(ID)).map((e) => e.text)).toEqual(['l8', 'l9', 'l10'])
  })

  it('prunes logs of missions that left saved history and nothing else', () => {
    writeFileSync(path.join(dir, 'KEEP0000000000000000000001.jsonl'), '')
    writeFileSync(path.join(dir, 'GONE0000000000000000000001.jsonl'), '')
    writeFileSync(path.join(dir, 'notes.txt'), 'not a log')
    const removed = new LogStore({ dir }).prune(['KEEP0000000000000000000001'])
    expect(removed).toBe(1)
    expect(readdirSync(dir).sort()).toEqual(['KEEP0000000000000000000001.jsonl', 'notes.txt'])
  })

  it('never prunes the log of a mission that is still being written', () => {
    const store = new LogStore({ dir })
    store.append(ID, { stream: 'stdout', text: 'running' })
    store.flushAll()
    expect(store.prune([])).toBe(0)
    expect(existsSync(path.join(dir, `${ID}.jsonl`))).toBe(true)
    store.close(ID)
  })

  it('only prunes plain files whose names are mission logs', () => {
    writeFileSync(path.join(dir, 'odd name.jsonl'), 'kept')
    mkdirSync(path.join(dir, 'FOLDER000000000000000000001.jsonl'))
    writeFileSync(path.join(dir, 'FOLDER000000000000000000001.jsonl', 'inner.txt'), 'kept')
    expect(new LogStore({ dir }).prune([])).toBe(0)
    expect(readdirSync(dir).sort()).toEqual(['FOLDER000000000000000000001.jsonl', 'odd name.jsonl'])
    expect(existsSync(path.join(dir, 'FOLDER000000000000000000001.jsonl', 'inner.txt'))).toBe(true)
  })

  it('never follows a link inside the log folder when pruning', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'mechbay-outside-'))
    try {
      writeFileSync(path.join(outside, 'precious.txt'), 'keep me')
      // A junction needs no admin rights on Windows; elsewhere it is a directory symlink.
      symlinkSync(outside, path.join(dir, 'LINK0000000000000000000001.jsonl'), 'junction')
      expect(new LogStore({ dir }).prune([])).toBe(0)
      expect(readFileSync(path.join(outside, 'precious.txt'), 'utf8')).toBe('keep me')
      expect(readdirSync(dir)).toEqual(['LINK0000000000000000000001.jsonl'])
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('skips pruning entirely when the log folder itself is a link', () => {
    const outside = mkdtempSync(path.join(tmpdir(), 'mechbay-outside-'))
    const linked = path.join(dir, 'logs')
    try {
      writeFileSync(path.join(outside, 'GONE0000000000000000000001.jsonl'), 'not ours')
      symlinkSync(outside, linked, 'junction')
      expect(new LogStore({ dir: linked }).prune([])).toBe(0)
      expect(existsSync(path.join(outside, 'GONE0000000000000000000001.jsonl'))).toBe(true)
    } finally {
      rmSync(outside, { recursive: true, force: true })
    }
  })

  it('imports schema 2 log chunks once, without duplicating on a second start', async () => {
    const legacy = [
      { id: 'u1', deploymentId: ID, timestamp: 1, stream: 'stdout' as const, text: 'old line 1' },
      {
        id: 'u2',
        deploymentId: ID,
        timestamp: 2,
        stream: 'thought' as const,
        text: 'old idea',
        thoughtKind: 'intent' as const
      }
    ]
    const store = new LogStore({ dir })
    expect(store.importLegacy(legacy)).toBe(2)
    expect(store.importLegacy(legacy)).toBe(0)
    const history = await store.history(ID)
    expect(history.map((e) => [e.seq, e.text, e.thoughtKind])).toEqual([
      [1, 'old line 1', undefined],
      [2, 'old idea', 'intent']
    ])
  })

  it('skips schema 2 log chunks whose mission id could leave the log folder', () => {
    const store = new LogStore({ dir })
    const bad = {
      id: 'u1',
      deploymentId: '..\\escape',
      timestamp: 1,
      stream: 'stdout' as const,
      text: 'x'
    }
    expect(store.importLegacy([bad])).toBe(0)
    expect(readdirSync(dir)).toEqual([])
  })

  it('writes an imported log under a temporary name first, so a crash never leaves half of it', () => {
    const writes: string[] = []
    const fs = {
      ...realFs,
      writeFileSync: vi.fn((file: realFs.PathOrFileDescriptor, data: string) => {
        writes.push(String(file))
        realFs.writeFileSync(file, data)
      })
    }
    const store = new LogStore({ dir, fs: fs as never })
    const chunk = { id: 'u1', deploymentId: ID, timestamp: 1, stream: 'stdout' as const, text: 'x' }
    expect(store.importLegacy([chunk])).toBe(1)
    expect(writes.map((f) => path.basename(f))).toEqual([`${ID}.jsonl.tmp`])
    expect(readdirSync(dir)).toEqual([`${ID}.jsonl`])
  })

  it('skips malformed schema 2 log chunks and imports the rest', async () => {
    const store = new LogStore({ dir })
    const good = { id: 'u1', deploymentId: ID, timestamp: 1, stream: 'stdout' as const, text: 'ok' }
    const chunks = [null, 'text', { deploymentId: 5 }, { deploymentId: ID, text: 7 }, good]
    expect(store.importLegacy(chunks as never)).toBe(1)
    expect((await store.history(ID)).map((e) => e.text)).toEqual(['ok'])
  })

  it('hides known keys in imported schema 2 log lines', async () => {
    const store = new LogStore({ dir })
    const key = 'sk-ant-legacy-0123456789'
    const chunk = {
      id: 'u1',
      deploymentId: ID,
      timestamp: 1,
      stream: 'stdout' as const,
      text: `ANTHROPIC_API_KEY=${key}`
    }
    store.importLegacy([chunk], (text) => text.split(key).join('[redacted]'))
    expect((await store.history(ID)).map((e) => e.text)).toEqual(['ANTHROPIC_API_KEY=[redacted]'])
    expect(readFileSync(path.join(dir, `${ID}.jsonl`), 'utf8')).not.toContain(key)
  })
})

describe('log folders and startup', () => {
  it('demo and real logs live in separate folders', () => {
    const userData = path.join('C:', 'Users', 'pilot', 'AppData', 'Roaming', 'mechbay')
    expect(logDirFor(userData, false)).toBe(path.join(userData, 'mechbay', 'logs'))
    expect(logDirFor(userData, true)).toBe(path.join(userData, 'mechbay', 'logs-demo'))
  })

  it('skips pruning while the saved bay is read-only', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mechbay-logs-'))
    mkdirSync(dir, { recursive: true })
    writeFileSync(path.join(dir, `${ID}.jsonl`), '')
    const store = new LogStore({ dir })
    prepareLogStore(store, {
      getHealth: () => ({ ok: false, reason: 'newer-version', message: 'newer' }),
      getState: () => ({ deployments: [] }),
      startedFresh: () => false,
      takeLegacyLogChunks: () => []
    } as never)
    expect(existsSync(path.join(dir, `${ID}.jsonl`))).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  })

  it('skips pruning when the saved bay was started fresh after damage', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mechbay-logs-'))
    try {
      writeFileSync(path.join(dir, `${ID}.jsonl`), '')
      const store = new LogStore({ dir })
      prepareLogStore(store, {
        getHealth: () => ({ ok: true, notice: 'started a fresh one' }),
        getState: () => ({ deployments: [] }),
        startedFresh: () => true,
        takeLegacyLogChunks: () => []
      } as never)
      expect(existsSync(path.join(dir, `${ID}.jsonl`))).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('passes legacy lines through the given redaction on startup', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mechbay-logs-'))
    try {
      const store = new LogStore({ dir })
      prepareLogStore(
        store,
        {
          getHealth: () => ({ ok: true }),
          getState: () => ({ deployments: [{ id: ID }] }),
          startedFresh: () => false,
          takeLegacyLogChunks: () => [
            { id: 'u1', deploymentId: ID, timestamp: 1, stream: 'stdout', text: 'key sk-secret-99' }
          ]
        } as never,
        { redact: (text) => text.replace('sk-secret-99', '[redacted]') }
      )
      expect((await store.history(ID)).map((e) => e.text)).toEqual(['key [redacted]'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('imports legacy logs, then prunes logs of missions no longer in history', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'mechbay-logs-'))
    try {
      writeFileSync(path.join(dir, 'GONE0000000000000000000001.jsonl'), '')
      const store = new LogStore({ dir })
      prepareLogStore(store, {
        getHealth: () => ({ ok: true }),
        getState: () => ({ deployments: [{ id: ID }] }),
        startedFresh: () => false,
        takeLegacyLogChunks: () => [
          { id: 'u1', deploymentId: ID, timestamp: 1, stream: 'stdout', text: 'kept line' }
        ]
      } as never)
      expect(readdirSync(dir)).toEqual([`${ID}.jsonl`])
      expect((await store.history(ID)).map((e) => e.text)).toEqual(['kept line'])
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
