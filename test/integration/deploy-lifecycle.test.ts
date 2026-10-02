import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ClaudeRunner } from '../../src/main/runners/claude'
import { StateManager, type StoreLike } from '../../src/main/state-manager'
import { NarrationParser } from '../../src/main/log-narration-parser'
import type { LogChunk } from '../../src/shared/types'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function makeInMemoryStore(): StoreLike {
  const data: Record<string, unknown> = {}
  return {
    get: (k: string) => data[k],
    set: (k: string, v: unknown) => {
      data[k] = v
    },
    has: (k: string) => k in data
  }
}

describe('deployment lifecycle (integration)', () => {
  it('streams fixture content end-to-end and resolves with exit 0', async () => {
    const fixturePath = path.join(__dirname, '../fixtures/claude-output-samples/hello.txt')
    const fixtureContent = fs.readFileSync(fixturePath, 'utf-8')

    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from([fixtureContent])
    fakeChild.stderr = Readable.from([])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'echo hello world')

    setTimeout(() => fakeChild.emit('close', 0), 10)
    setTimeout(() => fakeChild.emit('exit', 0), 11)

    const chunks: string[] = []
    for await (const chunk of result.stream) chunks.push(chunk.text)

    expect(chunks.join('')).toBe(fixtureContent)
    expect(await result.exit).toBe(0)
  })

  it('persists state across StateManager re-instantiation', () => {
    const store = makeInMemoryStore()
    const sm = new StateManager(store, '/tmp/integration-test')
    const originalCount = sm.getState().companions.length

    // Add a fake facility
    sm.updateState((s) => ({
      ...s,
      facilities: [
        ...s.facilities,
        {
          id: 'facility-test-id',
          name: 'test-facility',
          path: '/tmp/test-project',
          facilityType: 'research-lab',
          tile: { x: 10, y: 5 },
          source: 'manual',
          discoveredAt: Date.now()
        }
      ]
    }))

    // Simulate app restart: new StateManager from same store
    const sm2 = new StateManager(store, '/tmp/integration-test')
    const reloaded = sm2.getState()
    expect(reloaded.companions).toHaveLength(originalCount)
    // 6 seeded facilities + 1 test-added = 7
    expect(reloaded.facilities).toHaveLength(7)
    expect(reloaded.facilities.some((f) => f.name === 'test-facility')).toBe(true)
  })

  it('captures stderr alongside stdout in chunk stream', async () => {
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from(['progress: 50%\n'])
    fakeChild.stderr = Readable.from(['warning: deprecated flag\n'])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => fakeChild.emit('close', 0), 10)
    setTimeout(() => fakeChild.emit('exit', 0), 11)

    const stdoutChunks: string[] = []
    const stderrChunks: string[] = []
    for await (const chunk of result.stream) {
      if (chunk.stream === 'stdout') stdoutChunks.push(chunk.text)
      else stderrChunks.push(chunk.text)
    }

    expect(stdoutChunks.join('')).toContain('progress: 50%')
    expect(stderrChunks.join('')).toContain('warning')
  })

  it('classifies [INTENT] and [FINDINGS] markers as thought LogChunks end-to-end', async () => {
    // Scripted runner emits a realistic narration sequence mirroring
    // what Kimi produces with --narrate: intent → tool call → findings.
    const fakeChild = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    fakeChild.stdout = Readable.from(['Done.\n'])
    fakeChild.stderr = Readable.from([
      '[INTENT] Exploring the repo.\n',
      '  -> read_file({"path":"package.json"})\n',
      '[FINDINGS] Electron + Vite project.\n'
    ])
    fakeChild.kill = vi.fn()

    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: (() => fakeChild) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => fakeChild.emit('close', 0), 10)
    setTimeout(() => fakeChild.emit('exit', 0), 11)

    // Replicate the ipc.ts deploy loop: route chunks through
    // NarrationParser and accumulate classified LogChunks.
    const parser = new NarrationParser()
    const emitted: Array<Pick<LogChunk, 'stream' | 'text' | 'thoughtKind'>> = []
    for await (const chunk of result.stream) {
      for (const parsed of parser.feed(chunk)) {
        emitted.push({
          stream: parsed.stream,
          text: parsed.text,
          ...(parsed.thoughtKind ? { thoughtKind: parsed.thoughtKind } : {})
        })
      }
    }
    for (const parsed of parser.flush()) {
      emitted.push({
        stream: parsed.stream,
        text: parsed.text,
        ...(parsed.thoughtKind ? { thoughtKind: parsed.thoughtKind } : {})
      })
    }
    expect(await result.exit).toBe(0)

    const intent = emitted.find((c) => c.stream === 'thought' && c.thoughtKind === 'intent')
    const findings = emitted.find((c) => c.stream === 'thought' && c.thoughtKind === 'findings')

    expect(intent).toBeDefined()
    expect(intent!.text).toBe('Exploring the repo.\n')
    expect(findings).toBeDefined()
    expect(findings!.text).toBe('Electron + Vite project.\n')

    // Raw tool-call line still present on stderr (not reclassified).
    expect(emitted.find((c) => c.stream === 'stderr' && c.text.includes('read_file'))).toBeDefined()

    // Final stdout not lost.
    expect(emitted.find((c) => c.stream === 'stdout' && c.text.includes('Done.'))).toBeDefined()
  })
})
