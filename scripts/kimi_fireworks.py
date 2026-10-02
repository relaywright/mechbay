#!/usr/bin/env python3
"""Kimi K2.5 Turbo Agent via Fireworks AI.

Full agentic loop with file I/O, shell commands, web search, and URL fetching.
Uses the OpenAI-compatible Fireworks API with function calling.

Usage:
    python kimi_fireworks.py "Your prompt here"
    python kimi_fireworks.py -f prompt.txt
    python kimi_fireworks.py -s "You are a code reviewer" "Review this code..."
    python kimi_fireworks.py --max-turns 500 -w /path/to/project "Extra-long task"
    echo "prompt" | python kimi_fireworks.py -

Options:
    -s, --system      System prompt
    -f, --file        Read user prompt from file
    -w, --workdir     Working directory for file ops (default: cwd)
    --max-turns       Max agent loop iterations (default: 300)
    --temperature     Model temperature (default: 0.3 for tool use)
    --max-tokens      Max tokens per response (default: 16384). Fireworks requires
                      stream=true for values > 4096; the wrapper streams transparently
                      and returns a single assembled response, so callers don't need
                      to handle chunks.
    -v, --verbose     Print tool calls to stderr
    --no-tools        Disable tools (simple prompt -> response mode)
    --model           Override model name

Environment:
    FIREWORKS_API_KEY  Required. MechBay injects a key stored in Settings.
"""

import argparse
import html as html_lib
import json
import os
import re
import subprocess
import sys
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

# --- Configuration ---
API_BASE = "https://api.fireworks.ai/inference/v1"
DEFAULT_MODEL = "accounts/fireworks/routers/kimi-k2p5-turbo"
API_KEY_ENV = "FIREWORKS_API_KEY"

NARRATION_DIRECTIVE = (
    "You are being watched by an operator through a live log. "
    "Before using tools, briefly state your immediate intent in one sentence, "
    "prefixed with [INTENT]. After a batch of roughly 3-5 tool calls, or when "
    "you reach a natural subtask boundary, emit a one-sentence reflection "
    "prefixed with [FINDINGS]. Keep each bullet to a single line — no multi-line "
    "paragraphs. These bullets are for the operator's narrative view; do not "
    "describe the bullet system itself, just use it."
)

# Directories to skip during file searches
SKIP_DIRS = {
    ".git", "node_modules", "__pycache__", ".next", ".cache", "dist",
    "build", "coverage", ".venv", "venv", ".tox", ".mypy_cache",
    ".pytest_cache", "win-unpacked", "release", ".turbo",
}

# --- Tool Definitions ---
TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "read_file",
            "description": "Read the contents of a file. Returns the file content as text.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Absolute or relative file path",
                    }
                },
                "required": ["path"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "write_file",
            "description": "Write content to a file. Creates parent dirs if needed. Overwrites existing content.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path to write to",
                    },
                    "content": {
                        "type": "string",
                        "description": "Content to write",
                    },
                },
                "required": ["path", "content"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "edit_file",
            "description": "Replace a specific string in a file. The old_string must match exactly (including whitespace).",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "File path to edit",
                    },
                    "old_string": {
                        "type": "string",
                        "description": "Exact text to find and replace",
                    },
                    "new_string": {
                        "type": "string",
                        "description": "Replacement text",
                    },
                },
                "required": ["path", "old_string", "new_string"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "list_directory",
            "description": "List files and directories at the given path.",
            "parameters": {
                "type": "object",
                "properties": {
                    "path": {
                        "type": "string",
                        "description": "Directory path (default: working directory)",
                    }
                },
                "required": [],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "run_command",
            "description": "Execute a shell command and return stdout/stderr. Use for builds, tests, git, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "command": {
                        "type": "string",
                        "description": "Shell command to execute",
                    },
                    "timeout": {
                        "type": "integer",
                        "description": "Timeout in seconds (default: 120)",
                    },
                },
                "required": ["command"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "search_web",
            "description": "Search the web via DuckDuckGo. Returns titles, URLs, and snippets.",
            "parameters": {
                "type": "object",
                "properties": {
                    "query": {
                        "type": "string",
                        "description": "Search query",
                    }
                },
                "required": ["query"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "fetch_url",
            "description": "Fetch a URL and return its content as plain text (HTML tags stripped).",
            "parameters": {
                "type": "object",
                "properties": {
                    "url": {
                        "type": "string",
                        "description": "URL to fetch",
                    }
                },
                "required": ["url"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "find_files",
            "description": "Search for files matching a glob pattern. Skips node_modules, .git, etc.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Glob pattern (e.g., '**/*.ts', 'src/**/*.py')",
                    },
                    "path": {
                        "type": "string",
                        "description": "Base directory (default: working directory)",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
    {
        "type": "function",
        "function": {
            "name": "grep",
            "description": "Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.",
            "parameters": {
                "type": "object",
                "properties": {
                    "pattern": {
                        "type": "string",
                        "description": "Search pattern (regex)",
                    },
                    "path": {
                        "type": "string",
                        "description": "File or directory to search (default: working directory)",
                    },
                    "include": {
                        "type": "string",
                        "description": "File extension filter (e.g., '*.ts', '*.py')",
                    },
                },
                "required": ["pattern"],
            },
        },
    },
]


# --- API Key ---


def get_api_key():
    """Get the Fireworks API key from the environment."""
    return os.environ.get(API_KEY_ENV) or None


# --- Tool Implementations ---


def _resolve(path, workdir):
    """Resolve a path relative to workdir."""
    p = Path(path)
    return p if p.is_absolute() else Path(workdir) / p


def _should_skip(path):
    """Check if a path component is in the skip list."""
    return any(part in SKIP_DIRS for part in Path(path).parts)


def tool_read_file(args, workdir):
    p = _resolve(args["path"], workdir)
    if not p.exists():
        return f"[ERROR] File not found: {p}"
    content = p.read_text(encoding="utf-8", errors="replace")
    if len(content) > 200_000:
        return content[:100_000] + "\n...[TRUNCATED — file too large]...\n" + content[-100_000:]
    return content


def tool_write_file(args, workdir):
    p = _resolve(args["path"], workdir)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(args["content"], encoding="utf-8")
    return f"Written {len(args['content'])} chars to {p}"


def tool_edit_file(args, workdir):
    p = _resolve(args["path"], workdir)
    if not p.exists():
        return f"[ERROR] File not found: {p}"
    content = p.read_text(encoding="utf-8", errors="replace")
    old = args["old_string"]
    new = args["new_string"]
    if old not in content:
        return f"[ERROR] old_string not found in {p}. Check whitespace and exact match."
    count = content.count(old)
    if count > 1:
        return f"[ERROR] old_string matches {count} locations in {p}. Provide more context to make it unique."
    content = content.replace(old, new, 1)
    p.write_text(content, encoding="utf-8")
    return f"Edited {p} (replaced 1 occurrence)"


def tool_list_directory(args, workdir):
    p = _resolve(args.get("path", ""), workdir)
    if not p.is_dir():
        return f"[ERROR] Not a directory: {p}"
    entries = []
    for e in sorted(p.iterdir(), key=lambda x: (not x.is_dir(), x.name.lower())):
        if e.name in SKIP_DIRS:
            continue
        prefix = "[dir]  " if e.is_dir() else "       "
        entries.append(f"{prefix}{e.name}")
    if not entries:
        return "(empty directory)"
    if len(entries) > 200:
        entries = entries[:200] + [f"... and more entries"]
    return "\n".join(entries)


def tool_run_command(args, workdir):
    command = args["command"]
    timeout = args.get("timeout", 120)
    try:
        result = subprocess.run(
            command,
            shell=True,
            capture_output=True,
            text=True,
            timeout=timeout,
            cwd=workdir,
            encoding="utf-8",
            errors="replace",
        )
    except subprocess.TimeoutExpired:
        return f"[ERROR] Command timed out after {timeout}s: {command}"
    output = ""
    if result.stdout:
        output += result.stdout
    if result.stderr:
        output += f"\n[STDERR]\n{result.stderr}"
    output += f"\n[EXIT CODE: {result.returncode}]"
    if len(output) > 50_000:
        output = output[:25_000] + "\n...[TRUNCATED]...\n" + output[-25_000:]
    return output


def tool_search_web(args):
    query = args["query"]
    params = urllib.parse.urlencode({"q": query})
    url = f"https://html.duckduckgo.com/html/?{params}"
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; KimiAgent/1.0)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            html = resp.read().decode("utf-8", errors="replace")
    except (urllib.error.URLError, TimeoutError) as e:
        return f"[ERROR] Search failed: {e}"

    results = []
    links = re.findall(
        r'<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>(.*?)</a>',
        html,
        re.DOTALL,
    )
    snippets = re.findall(
        r'<a[^>]*class="result__snippet"[^>]*>(.*?)</a>', html, re.DOTALL
    )
    for i, (href, title) in enumerate(links[:10]):
        title_clean = re.sub(r"<[^>]+>", "", title).strip()
        title_clean = html_lib.unescape(title_clean)
        snippet = ""
        if i < len(snippets):
            snippet = re.sub(r"<[^>]+>", "", snippets[i]).strip()
            snippet = html_lib.unescape(snippet)
        # Decode DuckDuckGo redirect URL
        if "uddg=" in href:
            match = re.search(r"uddg=([^&]+)", href)
            if match:
                href = urllib.parse.unquote(match.group(1))
        results.append(f"{i + 1}. {title_clean}\n   {href}\n   {snippet}\n")
    return "\n".join(results) or "No results found."


def tool_fetch_url(args):
    url = args["url"]
    req = urllib.request.Request(
        url, headers={"User-Agent": "Mozilla/5.0 (compatible; KimiAgent/1.0)"}
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read()
    except (urllib.error.URLError, TimeoutError) as e:
        return f"[ERROR] Fetch failed: {e}"
    try:
        text = raw.decode("utf-8")
    except UnicodeDecodeError:
        text = raw.decode("latin-1")
    # Strip script/style blocks, then all tags
    text = re.sub(r"<(script|style)[^>]*>.*?</\1>", "", text, flags=re.DOTALL | re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", text)
    text = re.sub(r"\s+", " ", text).strip()
    text = html_lib.unescape(text)
    if len(text) > 50_000:
        text = text[:50_000] + "\n...[TRUNCATED]..."
    return text or "[Empty page]"


def tool_find_files(args, workdir):
    base = _resolve(args.get("path", ""), workdir)
    pattern = args["pattern"]
    matches = []
    for p in base.glob(pattern):
        if _should_skip(p.relative_to(base)):
            continue
        matches.append(str(p.relative_to(base)))
        if len(matches) >= 200:
            matches.append("...[TRUNCATED — too many matches]...")
            break
    return "\n".join(sorted(matches)) or "No files found."


def tool_grep(args, workdir):
    pattern = args["pattern"]
    base = _resolve(args.get("path", ""), workdir)
    include = args.get("include", "")

    try:
        regex = re.compile(pattern)
    except re.error as e:
        return f"[ERROR] Invalid regex: {e}"

    results = []
    if base.is_file():
        files_to_search = [base]
    else:
        glob_pat = include if include else "*"
        files_to_search = []
        for p in base.rglob(glob_pat):
            if p.is_file() and not _should_skip(p.relative_to(base)):
                files_to_search.append(p)
            if len(files_to_search) >= 1000:
                break

    for filepath in files_to_search:
        try:
            content = filepath.read_text(encoding="utf-8", errors="replace")
        except (OSError, PermissionError):
            continue
        rel = str(filepath.relative_to(base)) if base.is_dir() else filepath.name
        for i, line in enumerate(content.split("\n"), 1):
            if regex.search(line):
                results.append(f"{rel}:{i}: {line.rstrip()}")
                if len(results) >= 200:
                    results.append("...[TRUNCATED — too many matches]...")
                    return "\n".join(results)

    return "\n".join(results) or "No matches found."


# --- Tool Dispatcher ---

TOOL_HANDLERS = {
    "read_file": lambda args, wd: tool_read_file(args, wd),
    "write_file": lambda args, wd: tool_write_file(args, wd),
    "edit_file": lambda args, wd: tool_edit_file(args, wd),
    "list_directory": lambda args, wd: tool_list_directory(args, wd),
    "run_command": lambda args, wd: tool_run_command(args, wd),
    "search_web": lambda args, _: tool_search_web(args),
    "fetch_url": lambda args, _: tool_fetch_url(args),
    "find_files": lambda args, wd: tool_find_files(args, wd),
    "grep": lambda args, wd: tool_grep(args, wd),
}


def execute_tool(name, args, workdir):
    """Execute a tool call and return the result string."""
    handler = TOOL_HANDLERS.get(name)
    if not handler:
        return f"[ERROR] Unknown tool: {name}"
    try:
        return handler(args, workdir)
    except Exception as e:
        return f"[ERROR] {type(e).__name__}: {e}"


# --- API Client ---


def chat_completion(messages, model, tools=None, temperature=0.3, max_tokens=16384):
    """Send a chat completion request to Fireworks API (streaming, transparent).

    Always uses stream=true because Fireworks rejects max_tokens > 4096
    without it. The SSE response is assembled into the same non-streaming
    dict shape callers already expect, so the agent loop is unaffected.
    """
    api_key = get_api_key()
    if not api_key:
        print(
            "[FATAL] FIREWORKS_API_KEY not found.\n"
            "Set it in your environment, or store a Kimi key in MechBay Settings.",
            file=sys.stderr,
        )
        sys.exit(1)

    body = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }
    if tools:
        body["tools"] = tools

    data = json.dumps(body).encode("utf-8")
    # User-Agent is required: Fireworks is behind Cloudflare, and urllib's
    # default "Python-urllib/3.X" fingerprint triggers Cloudflare error 1010
    # (browser-signature ban), producing a 403 before the request reaches
    # the API. Any non-urllib UA works; Mozilla is the safest bet.
    req = urllib.request.Request(
        f"{API_BASE}/chat/completions",
        data=data,
        headers={
            "Content-Type": "application/json",
            "Authorization": f"Bearer {api_key}",
            "Accept": "text/event-stream",
            "User-Agent": "Mozilla/5.0 (compatible; KimiAgent/1.0)",
        },
    )

    try:
        with urllib.request.urlopen(req, timeout=600) as resp:
            return _assemble_streamed_response(resp)
    except urllib.error.HTTPError as e:
        err_body = e.read().decode("utf-8", errors="replace")
        print(f"[ERROR] API returned {e.code}: {err_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"[ERROR] API connection failed: {e.reason}", file=sys.stderr)
        sys.exit(1)


def _assemble_streamed_response(resp):
    """Read a Fireworks SSE response and return a non-streaming-shaped dict.

    Collapses `data: {...}` lines into a single `{"choices": [{"message": ..., "finish_reason": ...}]}`
    payload identical to what the non-streaming endpoint would return. Tool
    calls are merged by index — `function.name` + `function.arguments` arrive
    as incremental fragments and must be concatenated.
    """
    content_parts = []
    tool_call_accum = {}  # index -> partial dict
    finish_reason = None
    role = "assistant"

    for raw_line in resp:
        line = raw_line.decode("utf-8", errors="replace").strip()
        if not line or not line.startswith("data:"):
            continue
        payload = line[len("data:"):].strip()
        if payload == "[DONE]":
            break
        try:
            chunk = json.loads(payload)
        except json.JSONDecodeError:
            continue

        choices = chunk.get("choices") or []
        if not choices:
            continue
        choice0 = choices[0]
        delta = choice0.get("delta") or {}

        if delta.get("role"):
            role = delta["role"]
        if delta.get("content") is not None:
            content_parts.append(delta["content"])

        for dtc in delta.get("tool_calls") or []:
            idx = dtc.get("index", 0)
            entry = tool_call_accum.setdefault(idx, {
                "id": "",
                "type": "function",
                "function": {"name": "", "arguments": ""},
            })
            if dtc.get("id"):
                entry["id"] = dtc["id"]
            if dtc.get("type"):
                entry["type"] = dtc["type"]
            dfn = dtc.get("function") or {}
            if dfn.get("name"):
                entry["function"]["name"] = dfn["name"]
            if dfn.get("arguments") is not None:
                entry["function"]["arguments"] += dfn["arguments"]

        if choice0.get("finish_reason"):
            finish_reason = choice0["finish_reason"]

    content = "".join(content_parts)
    message = {"role": role, "content": content if content else None}
    if tool_call_accum:
        message["tool_calls"] = [tool_call_accum[i] for i in sorted(tool_call_accum.keys())]

    return {
        "choices": [{
            "message": message,
            "finish_reason": finish_reason or "stop",
        }]
    }


# --- Agent Loop ---


def agent_loop(
    prompt,
    system_prompt=None,
    workdir=".",
    model=DEFAULT_MODEL,
    max_turns=300,
    temperature=0.3,
    max_tokens=16384,
    verbose=False,
    use_tools=True,
    narrate=False,
):
    """Run the agentic loop until the model produces a final text response."""
    messages = []
    effective_system = system_prompt
    if narrate:
        effective_system = (
            f"{system_prompt}\n\n{NARRATION_DIRECTIVE}"
            if system_prompt
            else NARRATION_DIRECTIVE
        )
    if effective_system:
        messages.append({"role": "system", "content": effective_system})
    messages.append({"role": "user", "content": prompt})

    tools = TOOLS if use_tools else None

    for turn in range(1, max_turns + 1):
        if verbose:
            print(f"\n--- Turn {turn}/{max_turns} ---", file=sys.stderr)

        response = chat_completion(
            messages, model=model, tools=tools,
            temperature=temperature, max_tokens=max_tokens,
        )
        choice = response["choices"][0]
        msg = choice["message"]
        messages.append(msg)

        # If no tool calls, we're done
        tool_calls = msg.get("tool_calls")
        if not tool_calls:
            return msg.get("content", "")

        # When --narrate is active, surface the model's pre-tool-call
        # reasoning. Without narration, this content is silently
        # discarded (we only return final content when there are NO
        # tool calls).
        if narrate:
            content = (msg.get("content") or "").strip()
            if content:
                for line in content.splitlines():
                    stripped = line.strip()
                    if stripped:
                        print(stripped, file=sys.stderr)

        # Execute each tool call
        for tc in tool_calls:
            fn = tc["function"]
            name = fn["name"]
            try:
                args = json.loads(fn["arguments"]) if fn.get("arguments") else {}
            except json.JSONDecodeError:
                args = {}

            if verbose:
                args_preview = json.dumps(args, ensure_ascii=False)
                if len(args_preview) > 300:
                    args_preview = args_preview[:300] + "..."
                print(f"  -> {name}({args_preview})", file=sys.stderr)

            result = execute_tool(name, args, workdir)

            if verbose:
                preview = result[:300] + "..." if len(result) > 300 else result
                print(f"  <- {preview}", file=sys.stderr)

            messages.append({
                "role": "tool",
                "tool_call_id": tc["id"],
                "content": result,
            })

    return "[WARNING] Reached max turns. Output may be incomplete."


# --- CLI ---


def main():
    parser = argparse.ArgumentParser(
        description="Kimi K2.5 Turbo Agent via Fireworks AI"
    )
    parser.add_argument("prompt", nargs="?", help="User prompt (use - for stdin)")
    parser.add_argument("-s", "--system", help="System prompt")
    parser.add_argument("-f", "--file", help="Read prompt from file")
    parser.add_argument("-w", "--workdir", default=".", help="Working directory")
    parser.add_argument("--max-turns", type=int, default=300, help="Max agent turns (default: 300; Fireworks Kimi is uncapped so high ceilings are safe)")
    parser.add_argument("--temperature", type=float, default=0.3, help="Temperature (default: 0.3)")
    parser.add_argument("--max-tokens", type=int, default=16384, help="Max tokens per response (default: 16384, streamed transparently)")
    parser.add_argument("-v", "--verbose", action="store_true", help="Print tool calls to stderr")
    parser.add_argument(
        "--narrate",
        action="store_true",
        help=(
            "Emit intent/findings narration to stderr. Appends a short directive "
            "to the system prompt and prints the model's pre-tool-call content so "
            "the operator can follow the agent's reasoning. Default: off."
        ),
    )
    parser.add_argument("--no-tools", action="store_true", help="Disable tools (prompt -> response only)")
    parser.add_argument("--model", default=DEFAULT_MODEL, help="Override model name")

    args = parser.parse_args()

    # Resolve prompt
    if args.file:
        prompt = Path(args.file).read_text(encoding="utf-8")
    elif args.prompt == "-":
        prompt = sys.stdin.read()
    elif args.prompt:
        prompt = args.prompt
    else:
        parser.error("Provide a prompt, use -f <file>, or pipe to stdin with -")
        return

    # Resolve workdir to absolute
    workdir = str(Path(args.workdir).resolve())

    result = agent_loop(
        prompt=prompt,
        system_prompt=args.system,
        workdir=workdir,
        model=args.model,
        max_turns=args.max_turns,
        temperature=args.temperature,
        max_tokens=args.max_tokens,
        verbose=args.verbose,
        use_tools=not args.no_tools,
        narrate=args.narrate,
    )

    print(result)


if __name__ == "__main__":
    main()
