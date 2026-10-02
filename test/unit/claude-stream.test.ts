import { readFileSync } from 'fs'
import path from 'path'
import { EventEmitter } from 'events'
import { Readable } from 'stream'
import { describe, expect, it, vi } from 'vitest'
import { ClaudeStreamFormatter } from '../../src/main/runners/claude-stream'
import { ClaudeRunner } from '../../src/main/runners/claude'

const FIXTURE = readFileSync(
  path.join(__dirname, '../fixtures/claude-stream/edit-files-denied.jsonl'),
  'utf8'
)

const EXPECTED = [
  'SESSION · Claude Code 2.1.287 · claude-haiku-4-5-20251001 · permission mode acceptEdits',
  '→ Read hello.txt',
  '→ Read missing.txt',
  'TOOL ERROR · File does not exist. Note: your current working directory is C:\\work\\demo-facility.',
  '→ Edit hello.txt',
  '→ PowerShell: npm test',
  'DENIED · PowerShell: npm test',
  '{"type":"mystery_event","detail":"a future event type"}',
  'Warning: a plain line that is not JSON',
  'I\'ve appended "third line" to hello.txt, but npm test couldn\'t run in this non-interactive session due to permission restrictions.',
  'DONE · 5 turns · 11.7s · $0.0541',
  'BLOCKED · 1 action needed approval and was denied.'
]

function run(
  text: string,
  chunkSize: number,
  formatter = new ClaudeStreamFormatter()
): { out: string; formatter: ClaudeStreamFormatter } {
  let out = ''
  for (let i = 0; i < text.length; i += chunkSize)
    out += formatter.push(text.slice(i, i + chunkSize))
  out += formatter.end()
  return { out, formatter }
}

describe('ClaudeStreamFormatter', () => {
  it('turns a recorded run into readable lines, whatever the chunk boundaries', () => {
    for (const size of [37, 1, 4096]) {
      expect(run(FIXTURE, size).out).toBe(EXPECTED.map((l) => `${l}\n`).join(''))
    }
  })

  it('handles Windows line endings', () => {
    expect(run(FIXTURE.replace(/\n/g, '\r\n'), 37).out).toBe(EXPECTED.map((l) => `${l}\n`).join(''))
  })

  it('reports each denied action once', () => {
    expect(run(FIXTURE, 37).formatter.report()).toEqual({
      permissionDenials: ['PowerShell: npm test']
    })
  })

  it("never prints Claude's own denial message or an em dash", () => {
    const { out } = run(FIXTURE, 37)
    expect(out).not.toContain('no approval surface')
    expect(out).not.toContain('\u2014')
  })

  it('passes plain text through unchanged, including a last line with no newline', () => {
    expect(run('hello\nworld', 3).out).toBe('hello\nworld')
  })

  it('reports a failed run', () => {
    const { out } = run(
      '{"type":"result","subtype":"error_max_turns","is_error":true,"num_turns":30}\n',
      50
    )
    expect(out).toBe('FAILED · error_max_turns\n')
  })

  it('counts denials found only in the final result', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      duration_ms: 900,
      total_cost_usd: 0.001,
      permission_denials: [
        { tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'rm -rf build' } },
        { tool_name: 'Write', tool_use_id: 'b', tool_input: { file_path: '/tmp/x' } }
      ]
    })
    const { out, formatter } = run(`${line}\n`, 50)
    expect(out).toBe(
      'DONE · 1 turn · 0.9s · $0.0010\nBLOCKED · 2 actions needed approval and were denied.\n'
    )
    expect(formatter.report().permissionDenials).toEqual(['Bash: rm -rf build', 'Write /tmp/x'])
  })

  it('does not list ExitPlanMode or AskUserQuestion as blocked actions', () => {
    const line = JSON.stringify({
      type: 'result',
      subtype: 'success',
      num_turns: 2,
      permission_denials: [
        { tool_name: 'ExitPlanMode', tool_use_id: 'p', tool_input: { plan: 'Do it' } },
        { tool_name: 'AskUserQuestion', tool_use_id: 'q', tool_input: {} },
        { tool_name: 'Write', tool_use_id: 'w', tool_input: { file_path: '/tmp/x' } }
      ]
    })
    const { out, formatter } = run(`${line}\n`, 50)
    expect(out).toBe('DONE · 2 turns\nBLOCKED · 1 action needed approval and was denied.\n')
    expect(formatter.report().permissionDenials).toEqual(['Write /tmp/x'])
  })

  it('keeps blank lines in plain text', () => {
    expect(run('first\n\nsecond\n', 4).out).toBe('first\n\nsecond\n')
  })

  it('shows malformed, cut-off or oddly shaped JSON without stopping', () => {
    const input = [
      '{"type":"assistant","message":{"content":[{"type":"tool_use"',
      '[1,2]',
      'null',
      '{"type":"assistant","message":{"content":"not a list"}}',
      '{"type":"user","message":null}',
      '{"type":"assistant","message":{"content":[null,7,{"type":"tool_use","id":5,"name":["x"],"input":"y"}]}}',
      '{"type":"result","subtype":"success","num_turns":"many","duration_ms":null,"total_cost_usd":"free"}',
      'still here'
    ].join('\n')
    expect(run(`${input}\n`, 7).out).toBe(
      [
        '{"type":"assistant","message":{"content":[{"type":"tool_use"',
        '[1,2]',
        'null',
        '→ unknown tool',
        'DONE · 0 turns',
        'still here'
      ]
        .map((l) => `${l}\n`)
        .join('')
    )
  })

  it('shortens a very long plain line and keeps going', () => {
    const { out } = run(`${'x'.repeat(5000)}\nnext\n`, 333)
    const [first, second] = out.split('\n')
    expect(first).toHaveLength(2000)
    expect(first.endsWith('…')).toBe(true)
    expect(second).toBe('next')
  })

  it('skips a line too long to hold in memory, once, and shows the rest', () => {
    const formatter = new ClaudeStreamFormatter({ maxLineLength: 100 })
    const input = `before\n${'{"type":"user"'.repeat(50)}\nafter\n`
    const { out } = run(input, 9, formatter)
    expect(out).toBe('before\nSKIPPED · one line of output was too long to show.\nafter\n')
  })

  it('drops an over-long last line at the end of the run without crashing', () => {
    const formatter = new ClaudeStreamFormatter({ maxLineLength: 10 })
    expect(run('ok\n0123456789abcdef', 4, formatter).out).toBe(
      'ok\nSKIPPED · one line of output was too long to show.\n'
    )
  })

  it('never cuts a character in half when shortening', () => {
    const { out } = run(`${'a'.repeat(1998)}🚀🚀\n`, 100)
    expect(out).toBe(`${'a'.repeat(1998)}…\n`)
  })
})

describe('ClaudeRunner output decoding', () => {
  function fakeChild(
    stdout: Buffer[],
    stderr: Buffer[]
  ): EventEmitter & {
    stdout: Readable
    stderr: Readable
    kill: ReturnType<typeof vi.fn>
  } {
    const child = new EventEmitter() as EventEmitter & {
      stdout: Readable
      stderr: Readable
      kill: ReturnType<typeof vi.fn>
    }
    child.stdout = Readable.from(stdout)
    child.stderr = Readable.from(stderr)
    child.kill = vi.fn()
    return child
  }

  it('keeps multi-byte characters intact when a chunk boundary splits them', async () => {
    const event = Buffer.from(
      `${JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Café ✓ 🚀 done' }] } })}\n`,
      'utf8'
    )
    const cut = event.indexOf(Buffer.from('🚀', 'utf8')) + 2
    const warning = Buffer.from('avertissement: déjà vu\n', 'utf8')
    const errCut = warning.indexOf(Buffer.from('é', 'utf8')) + 1
    const child = fakeChild(
      [event.subarray(0, cut), event.subarray(cut)],
      [warning.subarray(0, errCut), warning.subarray(errCut)]
    )
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: (() => child) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => child.emit('close', 0), 10)
    setTimeout(() => child.emit('exit', 0), 11)

    let out = ''
    let err = ''
    for await (const chunk of result.stream) {
      if (chunk.stream === 'stdout') out += chunk.text
      else err += chunk.text
    }
    expect(out).toBe('Café ✓ 🚀 done\n')
    expect(err).toBe('avertissement: déjà vu\n')
    expect(out + err).not.toContain('\uFFFD')
  })

  it('exposes the denial report after the run', async () => {
    const line = `${JSON.stringify({
      type: 'result',
      subtype: 'success',
      num_turns: 1,
      permission_denials: [{ tool_name: 'Bash', tool_use_id: 'a', tool_input: { command: 'ls' } }]
    })}\n`
    const child = fakeChild([Buffer.from(line)], [])
    const runner = new ClaudeRunner({
      which: async () => '/fake/claude',
      spawnProcess: (() => child) as never
    })

    const result = await runner.spawn('/tmp', 'noop')
    setTimeout(() => child.emit('close', 0), 10)
    setTimeout(() => child.emit('exit', 0), 11)
    for await (const _chunk of result.stream) {
      // drain
    }
    expect(result.report?.()).toEqual({ permissionDenials: ['Bash: ls'] })
  })
})
