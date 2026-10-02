import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

/**
 * The Kimi wrapper needs FIREWORKS_API_KEY to call the API, but the shell
 * commands the agent runs do not, and neither do the other runtimes' keys.
 * If they inherited them, a single `env` or `echo $FIREWORKS_API_KEY` would
 * print a key into the live log. Tool output that quotes the Fireworks key
 * anyway (say, a file the agent read) is redacted before it goes back to
 * the model or into the verbose log.
 */

const SCRIPTS_DIR = path.resolve(__dirname, '../../scripts')
const FAKE_KEY = 'fw-test-key-should-not-leak-123'
const DROPPED_KEYS: Record<string, string> = {
  FIREWORKS_API_KEY: FAKE_KEY,
  ANTHROPIC_API_KEY: 'sk-ant-test-should-not-leak-456',
  OPENAI_API_KEY: 'sk-openai-test-should-not-leak-789',
  GEMINI_API_KEY: 'gemini-test-should-not-leak-012',
  MECHBAY_HERMES_API_KEY: 'hermes-test-should-not-leak-345'
}

/** First interpreter that really runs Python 3 (Windows' `python3` can be a Store stub). */
function findPython(): string | null {
  const candidates = process.platform === 'win32' ? ['python', 'py'] : ['python3', 'python']
  for (const candidate of candidates) {
    const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
    if (probe.status === 0 && /^Python 3/.test(`${probe.stdout}${probe.stderr}`.trim())) {
      return candidate
    }
  }
  return null
}

const python = findPython()
const workdirs: string[] = []
// Each test starts one or two Python interpreters, which can take seconds
// while the rest of the suite runs in parallel.
const PYTHON_TIMEOUT_MS = 30_000

afterEach(() => {
  for (const dir of workdirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** Run Python lines after importing kimi_fireworks, with every runtime key set. */
function runDriver(
  lines: string[],
  workdir: string
): { status: number | null; stdout: string; stderr: string } {
  const driver = [
    'import json, os, sys',
    'sys.path.insert(0, os.environ["MECHBAY_SCRIPTS_DIR"])',
    'import kimi_fireworks',
    ...lines
  ].join('\n')
  return spawnSync(python as string, ['-c', driver], {
    encoding: 'utf8',
    windowsHide: true,
    env: {
      ...process.env,
      ...DROPPED_KEYS,
      MECHBAY_SCRIPTS_DIR: SCRIPTS_DIR,
      MECHBAY_WORKDIR: workdir,
      PYTHONDONTWRITEBYTECODE: '1'
    }
  })
}

describe('kimi_fireworks.py run_command tool', () => {
  it.skipIf(python === null)(
    'runs agent shell commands without any runtime API key',
    () => {
      // The agent's command is another Python one-liner that prints each key
      // (or a marker when it is absent), so it behaves the same under cmd.exe
      // and sh.
      const names = `[${Object.keys(DROPPED_KEYS)
        .map((name) => `\\'${name}\\'`)
        .join(', ')}]`
      const result = runDriver(
        [
          `inner = '"' + sys.executable + '" -c "import os; [print(n, os.environ.get(n, \\'KEY-ABSENT\\')) for n in ${names}]"'`,
          'print(kimi_fireworks.tool_run_command({"command": inner}, os.environ["MECHBAY_WORKDIR"]))'
        ],
        tmpdir()
      )

      expect(result.stderr).toBe('')
      expect(result.status).toBe(0)
      for (const [name, value] of Object.entries(DROPPED_KEYS)) {
        expect(result.stdout).toContain(`${name} KEY-ABSENT`)
        expect(result.stdout).not.toContain(value)
      }
    },
    PYTHON_TIMEOUT_MS
  )
})

describe('kimi_fireworks.py agent loop', () => {
  it.skipIf(python === null)(
    'redacts the Fireworks key from tool results before the model or the log sees them',
    () => {
      const workdir = mkdtempSync(path.join(tmpdir(), 'mechbay-kimi-redact-'))
      workdirs.push(workdir)
      writeFileSync(path.join(workdir, 'leak.txt'), `FIREWORKS_API_KEY=${FAKE_KEY}\n`)

      // A fake model asks to read the file once, then finishes. Each call
      // records the messages it was sent, so the tool result checked here is
      // exactly what the real model would have received.
      const result = runDriver(
        [
          'seen = []',
          'def fake_chat(messages, **kwargs):',
          '    seen.append(json.loads(json.dumps(messages)))',
          '    if len(seen) == 1:',
          '        call = {"id": "t1", "type": "function", "function": {"name": "read_file", "arguments": json.dumps({"path": "leak.txt"})}}',
          '        return {"choices": [{"message": {"role": "assistant", "content": "", "tool_calls": [call]}}]}',
          '    return {"choices": [{"message": {"role": "assistant", "content": "done"}}]}',
          'kimi_fireworks.chat_completion = fake_chat',
          'kimi_fireworks.agent_loop("go", workdir=os.environ["MECHBAY_WORKDIR"], verbose=True)',
          'print(json.dumps([m["content"] for m in seen[-1] if m.get("role") == "tool"]))'
        ],
        workdir
      )

      expect(result.status).toBe(0)
      expect(JSON.parse(result.stdout.trim())).toEqual(['FIREWORKS_API_KEY=[redacted]\n'])
      expect(result.stderr).toContain('FIREWORKS_API_KEY=[redacted]')
      expect(result.stderr).not.toContain(FAKE_KEY)
    },
    PYTHON_TIMEOUT_MS
  )
})
