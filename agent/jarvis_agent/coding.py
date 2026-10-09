"""Runs Codex or Claude Code headless in one folder and streams what they do.

Both CLIs are used exactly as installed and signed in on this computer (your
ChatGPT / Claude accounts); the agent adds no keys of its own.
  codex exec --json --sandbox workspace-write --skip-git-repo-check -
  claude -p --output-format stream-json --verbose --permission-mode acceptEdits --allowedTools ...
"""

from __future__ import annotations

import json
import os
import re
import shutil
import signal
import subprocess
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable

IS_WIN = sys.platform == "win32"
MAX_SECONDS = 45 * 60

# Claude Code gets file tools plus ordinary build commands, nothing broader.
CLAUDE_TOOLS = ["Read", "Edit", "Write", "Glob", "Grep", "Bash(git:*)", "Bash(npm:*)", "Bash(npx:*)",
                "Bash(node:*)", "Bash(python:*)", "Bash(pip:*)", "Bash(pytest:*)", "Bash(ls:*)", "Bash(mkdir:*)"]


def _version_key(p: Path) -> tuple[int, ...]:
    return tuple(int(x) for x in re.findall(r"\d+", p.parent.parent.name)[:4]) or (0,)


def find_claude(configured: str = "") -> str | None:
    if configured and Path(configured).exists():
        return configured
    found = shutil.which("claude")
    if found:
        return found
    if IS_WIN:
        # The copy bundled with the Claude desktop app: %APPDATA%/Claude/claude-code/<version>/<hash>/claude.exe
        root = Path(os.environ.get("APPDATA", "")) / "Claude" / "claude-code"
        exes = sorted(root.glob("*/*/claude.exe"), key=_version_key, reverse=True) if root.is_dir() else []
        if exes:
            return str(exes[0])
    return None


def find_codex(configured: str = "") -> str | None:
    if configured and Path(configured).exists():
        return configured
    return shutil.which("codex")


def available(codex_bin: str = "", claude_bin: str = "") -> dict[str, str | None]:
    return {"codex": find_codex(codex_bin), "claude": find_claude(claude_bin)}


def kill_tree(proc: subprocess.Popen) -> None:
    if proc.poll() is not None:
        return
    try:
        if IS_WIN:
            subprocess.run(["taskkill", "/T", "/F", "/PID", str(proc.pid)], capture_output=True, timeout=10)
        else:
            os.killpg(proc.pid, signal.SIGTERM)
    except (OSError, subprocess.SubprocessError):
        proc.kill()


@dataclass
class RunResult:
    ok: bool
    summary: str
    error: str = ""
    files: list[str] = field(default_factory=list)


def parse_codex_event(line: str) -> tuple[str, str] | None:
    """One Codex JSONL event -> (kind, text) for the task log, or None to skip."""
    try:
        e = json.loads(line)
    except ValueError:
        return ("log", line[:400]) if line.strip() else None
    etype = e.get("type", "")
    item = e.get("item") or {}
    itype = item.get("type", "")
    if etype == "item.completed" and itype == "agent_message":
        return ("say", str(item.get("text", "")))
    if etype == "item.started" and itype == "command_execution":
        return ("cmd", f"$ {item.get('command', '')}")
    if etype == "item.completed" and itype == "command_execution" and item.get("exit_code") not in (0, None):
        return ("error", f"exit {item.get('exit_code')}: {str(item.get('aggregated_output', ''))[-300:]}")
    if etype == "item.completed" and itype == "file_change":
        changes = item.get("changes") or []
        return ("file", ", ".join(f"{c.get('kind', 'edit')} {c.get('path', '')}" for c in changes)[:600])
    if etype == "item.completed" and itype == "todo_list":
        return ("log", "Plan: " + "; ".join(str(i.get("text", "")) for i in item.get("items", []))[:600])
    if etype in ("turn.failed", "error"):
        err = e.get("error") or {}
        return ("error", str(err.get("message") if isinstance(err, dict) else err or e.get("message", "failed")))
    return None


def parse_claude_event(line: str) -> tuple[str, str] | None:
    try:
        e = json.loads(line)
    except ValueError:
        return ("log", line[:400]) if line.strip() else None
    if e.get("type") == "assistant":
        parts = []
        for block in (e.get("message") or {}).get("content") or []:
            if block.get("type") == "text" and block.get("text", "").strip():
                parts.append(("say", block["text"]))
            elif block.get("type") == "tool_use":
                inp = block.get("input") or {}
                target = inp.get("file_path") or inp.get("command") or inp.get("pattern") or ""
                kind = "file" if block.get("name") in ("Write", "Edit") else "cmd"
                parts.append((kind, f"{block.get('name')} {target}"[:400]))
        return parts[-1] if parts else None
    if e.get("type") == "result":
        return ("error" if e.get("is_error") else "say", str(e.get("result", ""))[:2000])
    return None


def run_agent(
    agent: str,
    exe: str,
    prompt: str,
    cwd: Path,
    log: Callable[[str, str], None],
    cancelled: Callable[[], bool],
) -> RunResult:
    if agent == "codex":
        cmd = [exe, "exec", "--json", "--sandbox", "workspace-write", "--skip-git-repo-check", "-"]
        parse = parse_codex_event
    else:
        cmd = [exe, "-p", "--output-format", "stream-json", "--verbose", "--permission-mode", "acceptEdits",
               "--allowedTools", *CLAUDE_TOOLS]
        parse = parse_claude_event

    proc = subprocess.Popen(
        cmd, cwd=str(cwd), stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, encoding="utf-8", errors="replace", bufsize=1,
        start_new_session=not IS_WIN,
        creationflags=subprocess.CREATE_NO_WINDOW if IS_WIN else 0,
    )
    assert proc.stdin and proc.stdout and proc.stderr
    proc.stdin.write(prompt)
    proc.stdin.close()

    stderr_tail: list[str] = []

    def drain_stderr() -> None:
        for line in proc.stderr:  # type: ignore[union-attr]
            stderr_tail.append(line.rstrip())
            del stderr_tail[:-30]

    threading.Thread(target=drain_stderr, daemon=True).start()

    stop = threading.Event()

    def watchdog() -> None:
        started = time.time()
        while not stop.wait(3):
            if cancelled() or time.time() - started > MAX_SECONDS:
                kill_tree(proc)
                return

    threading.Thread(target=watchdog, daemon=True).start()

    last_say = ""
    errors: list[str] = []
    for raw in proc.stdout:
        event = parse(raw.rstrip("\n"))
        if not event:
            continue
        kind, text = event
        if not text.strip():
            continue
        if kind == "say":
            last_say = text
        if kind == "error":
            errors.append(text)
        log(kind, text)
    code = proc.wait()
    stop.set()

    if cancelled():
        return RunResult(False, last_say, "Cancelled.")
    if code != 0:
        detail = errors[-1] if errors else "\n".join(stderr_tail[-5:]) or f"exit code {code}"
        if re.search(r"log ?in|logged in|auth|unauthori[sz]ed|api key", detail, re.I):
            detail += f"  (Sign in once on this computer: run `{Path(exe).name} login`.)" if agent == "codex" else \
                      f"  (Sign in once on this computer: run `{Path(exe).name} auth login`.)"
        return RunResult(False, last_say, detail[:1500])
    return RunResult(True, last_say or "Finished without a summary.")
