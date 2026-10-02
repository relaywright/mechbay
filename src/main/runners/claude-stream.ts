/**
 * Turns `claude -p --output-format stream-json --verbose` output (one JSON
 * event per line) into short readable lines for the mission log (P0-20).
 * Event shapes recorded from Claude Code 2.1.287. Anything unrecognized is
 * shown as-is, so a future event type is visible rather than lost.
 *
 * Bad input never stops the stream: a line that is not JSON, is cut off, or
 * has an unexpected shape is shown as-is (shortened), and a single line too
 * long to hold in memory is skipped with a notice while the lines after it
 * still come through.
 */

export interface RunReport {
  /** Labels of actions the CLI refused because they needed permission. */
  permissionDenials: string[]
}

/** Rewrites a runner's stdout. `push` and `end` return text to show (may be empty). */
export interface StreamTransform {
  push(text: string): string
  end(): string
  report(): RunReport
}

export interface ClaudeStreamFormatterOptions {
  /** Longest line (in characters) kept in memory while waiting for its newline. */
  maxLineLength?: number
}

type Json = Record<string, unknown>

const SKIPPED_SYSTEM = new Set([
  'hook_started',
  'hook_response',
  'hook_progress',
  'thinking_tokens',
  'task_started',
  'task_notification'
])
const SKIPPED_TYPES = new Set(['rate_limit_event'])
const MAX_RAW = 2000
/** About 32 MB of UTF-16. Real events with a large tool result stay well under this. */
const DEFAULT_MAX_LINE = 16 * 1024 * 1024
const SKIPPED_LINE = 'SKIPPED · one line of output was too long to show.'

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
const str = (v: unknown): string => (typeof v === 'string' ? v : '')
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v)

/** Shorten to `max` characters with an ellipsis, never splitting a surrogate pair. */
function clip(s: string, max: number): string {
  if (s.length <= max) return s
  let cut = max - 1
  const last = s.charCodeAt(cut - 1)
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1
  return `${s.slice(0, cut)}…`
}

export class ClaudeStreamFormatter implements StreamTransform {
  private buffer = ''
  /** True while discarding the rest of a line that passed `maxLineLength`. */
  private skipping = false
  private cwd = ''
  private readonly maxLineLength: number
  private readonly labels = new Map<string, string>()
  private readonly announced = new Set<string>()
  private readonly denials: string[] = []

  constructor(options: ClaudeStreamFormatterOptions = {}) {
    this.maxLineLength = options.maxLineLength ?? DEFAULT_MAX_LINE
  }

  push(text: string): string {
    const out: string[] = []
    let start = 0
    // Only the new text is scanned for newlines, so a long line arriving in
    // many chunks costs linear time.
    for (let nl = text.indexOf('\n'); nl !== -1; nl = text.indexOf('\n', start)) {
      const piece = text.slice(start, nl)
      if (this.skipping) this.skipping = false
      else out.push(...this.format(stripCr(this.buffer + piece)))
      this.buffer = ''
      start = nl + 1
    }
    if (!this.skipping) {
      this.buffer += text.slice(start)
      if (this.buffer.length > this.maxLineLength) {
        this.buffer = ''
        this.skipping = true
        out.push(SKIPPED_LINE)
      }
    }
    return out.map((line) => `${line}\n`).join('')
  }

  end(): string {
    const tail = stripCr(this.buffer)
    this.buffer = ''
    if (this.skipping) {
      this.skipping = false
      return ''
    }
    return tail ? this.format(tail).join('\n') : ''
  }

  report(): RunReport {
    return { permissionDenials: [...this.denials] }
  }

  private format(line: string): string[] {
    if (!line.trim()) return [line]
    let event: unknown
    try {
      event = JSON.parse(line)
    } catch {
      return [clip(line, MAX_RAW)]
    }
    if (!isObject(event)) return [clip(line, MAX_RAW)]

    try {
      switch (event.type) {
        case 'system':
          return this.system(event, line)
        case 'assistant':
          return this.assistant(event)
        case 'user':
          return this.toolResults(event)
        case 'result':
          return this.result(event)
        default:
          return SKIPPED_TYPES.has(str(event.type)) ? [] : [clip(line, MAX_RAW)]
      }
    } catch {
      // An event shape no handler expected: show the line rather than lose it.
      return [clip(line, MAX_RAW)]
    }
  }

  private system(event: Json, raw: string): string[] {
    const subtype = str(event.subtype)
    if (subtype === 'init') {
      this.cwd = str(event.cwd)
      return [
        `SESSION · Claude Code ${str(event.claude_code_version) || 'unknown'} · ${str(event.model) || 'default model'} · permission mode ${str(event.permissionMode) || 'default'}`
      ]
    }
    if (subtype === 'permission_denied')
      return this.deny(str(event.tool_use_id), str(event.tool_name))
    return SKIPPED_SYSTEM.has(subtype) ? [] : [clip(raw, MAX_RAW)]
  }

  private assistant(event: Json): string[] {
    const content = isObject(event.message) ? event.message.content : undefined
    if (!Array.isArray(content)) return []
    const out: string[] = []
    for (const block of content) {
      if (!isObject(block)) continue
      if (block.type === 'text' && str(block.text).trim()) out.push(str(block.text))
      if (block.type === 'tool_use') {
        const label = toolLabel(str(block.name), isObject(block.input) ? block.input : {}, this.cwd)
        this.labels.set(str(block.id), label)
        out.push(`→ ${label}`)
      }
    }
    return out
  }

  private toolResults(event: Json): string[] {
    const content = isObject(event.message) ? event.message.content : undefined
    if (!Array.isArray(content)) return []
    const deniedByMeta = new Set(
      (Array.isArray(event.tool_result_meta) ? event.tool_result_meta : [])
        .filter((m): m is Json => isObject(m) && m.non_execution_kind === 'permission-rule')
        .map((m) => str(m.id))
    )
    const out: string[] = []
    for (const block of content) {
      if (!isObject(block) || block.type !== 'tool_result' || block.is_error !== true) continue
      const id = str(block.tool_use_id)
      if (deniedByMeta.has(id) || this.announced.has(id)) {
        out.push(...this.deny(id, ''))
        continue
      }
      out.push(`TOOL ERROR · ${clip(firstLine(resultText(block.content)), 200)}`)
    }
    return out
  }

  private result(event: Json): string[] {
    for (const d of Array.isArray(event.permission_denials) ? event.permission_denials : []) {
      if (!isObject(d)) continue
      const id = str(d.tool_use_id)
      if (!this.labels.has(id)) {
        this.labels.set(
          id,
          toolLabel(str(d.tool_name), isObject(d.tool_input) ? d.tool_input : {}, this.cwd)
        )
      }
      this.deny(id, str(d.tool_name))
    }
    const out: string[] = []
    if (event.subtype === 'success') {
      const turns = Number(event.num_turns) || 0
      const parts = [`DONE · ${turns} turn${turns === 1 ? '' : 's'}`]
      if (finite(event.duration_ms)) parts.push(`${(event.duration_ms / 1000).toFixed(1)}s`)
      if (finite(event.total_cost_usd)) parts.push(`$${event.total_cost_usd.toFixed(4)}`)
      out.push(parts.join(' · '))
    } else {
      out.push(`FAILED · ${str(event.subtype) || 'unknown error'}`)
    }
    const n = this.denials.length
    if (n > 0)
      out.push(
        `BLOCKED · ${n} action${n === 1 ? '' : 's'} needed approval and ${n === 1 ? 'was' : 'were'} denied.`
      )
    return out
  }

  /** Record a denial once; returns the line to show the first time. */
  private deny(id: string, toolName: string): string[] {
    if (id && this.announced.has(id)) return []
    if (id) this.announced.add(id)
    const label = this.labels.get(id) ?? (toolName || 'a tool')
    this.denials.push(label)
    return [`DENIED · ${label}`]
  }
}

function stripCr(line: string): string {
  return line.endsWith('\r') ? line.slice(0, -1) : line
}

function toolLabel(name: string, input: Json, cwd: string): string {
  switch (name) {
    case 'Read':
    case 'Edit':
    case 'Write':
    case 'MultiEdit':
      return `${name} ${shortPath(str(input.file_path), cwd)}`
    case 'NotebookEdit':
      return `${name} ${shortPath(str(input.notebook_path), cwd)}`
    case 'Bash':
    case 'PowerShell':
      return `${name}: ${clip(str(input.command).replace(/\s+/g, ' ').trim(), 160)}`
    case 'Grep':
    case 'Glob':
      return `${name} "${clip(str(input.pattern), 120)}"`
    default:
      return name || 'unknown tool'
  }
}

/** Path relative to the session folder when it is inside it (case-insensitive, for Windows). */
function shortPath(file: string, cwd: string): string {
  if (!cwd) return file
  const base = cwd.replace(/[\\/]+$/, '')
  const head = file.slice(0, base.length)
  const sep = file.charAt(base.length)
  return head.toLowerCase() === base.toLowerCase() && (sep === '\\' || sep === '/')
    ? file.slice(base.length + 1)
    : file
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map((c) => (isObject(c) ? str(c.text) : '')).join('\n')
  return ''
}

function firstLine(text: string): string {
  return (
    text
      .replace(/<\/?tool_use_error>/g, '')
      .trim()
      .split(/\r?\n/)[0] ?? ''
  )
}
