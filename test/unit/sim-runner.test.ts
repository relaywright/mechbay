import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { SimRunner } from '../../src/main/runners/sim'

const tempDirs: string[] = []

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'mechbay-sim-runner-'))
  tempDirs.push(dir)
  return dir
}

async function collect(stream: AsyncIterable<{ stream: string; text: string }>): Promise<string[]> {
  const chunks: string[] = []
  for await (const chunk of stream) chunks.push(chunk.text)
  return chunks
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

describe('SimRunner', () => {
  it('streams a complete scripted mission and writes a report containing the prompt', async () => {
    const cwd = makeTempDir()
    const prompt = 'Calibrate the reactor telemetry before the next sortie.'
    const result = await new SimRunner('claude', { pacingMs: 0 }).spawn(cwd, prompt)

    const chunks = await collect(result.stream)

    expect(chunks.length).toBeGreaterThan(10)
    await expect(result.exit).resolves.toBe(0)
    expect(readFileSync(join(cwd, 'mission-report.md'), 'utf8')).toContain(prompt)
  })

  it('emits Raven intent and findings narration markers for Kimi', async () => {
    const cwd = makeTempDir()
    const result = await new SimRunner('kimi', { pacingMs: 0 }).spawn(cwd, 'Survey the facility.')

    const output = (await collect(result.stream)).join('')

    expect(output).toContain('▸ INTENT:')
    expect(output).toContain('◆ FINDINGS:')
    await expect(result.exit).resolves.toBe(0)
  })

  it('aborts promptly, terminates the stream, and resolves exit to -1', async () => {
    const cwd = makeTempDir()
    const result = await new SimRunner('codex', { pacingMs: 0 }).spawn(cwd, 'Stand down.')

    result.abort()
    const chunks = await collect(result.stream)

    expect(chunks.length).toBeLessThanOrEqual(1)
    await expect(result.exit).resolves.toBe(-1)
  })

  it('quotes only the task, never the soul preamble, in the log and the report', async () => {
    const cwd = makeTempDir()
    const assembledPrompt =
      '# Atlas-Prime · Soul\n\nI am Atlas. I hold the line.\n\n# Atlas-Prime · Memory\n\n(no entries)\n\n---\n\n# Current Task\n\nRefactor the reactor telemetry module.\n'
    const result = await new SimRunner('claude', { pacingMs: 0 }).spawn(cwd, assembledPrompt)
    const chunks = await collect(result.stream)
    await expect(result.exit).resolves.toBe(0)

    const taskLine = chunks.find((chunk) => chunk.includes('TASK //'))
    expect(taskLine).toContain('Refactor the reactor telemetry module.')
    expect(taskLine).not.toContain('Soul')

    const report = readFileSync(join(cwd, 'mission-report.md'), 'utf8')
    expect(report).toContain('Refactor the reactor telemetry module.')
    expect(report).not.toContain('I hold the line')
  })
})
