"""The server itself: files, shell, Python, what is running and how it is doing."""

from __future__ import annotations

import asyncio
import os
import platform
import re
import sys
import tempfile
import time

import psutil

from anexis.proc import report, run_process
from anexis.tools.base import DANGER, SAFE, WRITE, Tool, ToolContext, params, text
from anexis.tools.permissions import resolve

MAX_READ = 200_000


async def read_file(args: dict, ctx: ToolContext) -> str:
    path = resolve(args.get("path", ""), ctx.settings.workspace)
    if not path.is_file():
        return f"Error: file not found: {path}"
    data = path.read_bytes()[:MAX_READ]
    if b"\x00" in data[:4096]:
        return f"Error: {path.name} looks like a binary file ({path.stat().st_size} bytes)"
    return data.decode("utf-8", errors="replace")


async def write_file(args: dict, ctx: ToolContext) -> str:
    path = resolve(args.get("path", ""), ctx.settings.workspace)
    content = str(args.get("content", ""))
    path.parent.mkdir(parents=True, exist_ok=True)
    if args.get("append"):
        with path.open("a", encoding="utf-8") as f:
            f.write(content)
    else:
        path.write_text(content, encoding="utf-8")
    return f"Wrote {len(content)} characters to {path}"


async def list_dir(args: dict, ctx: ToolContext) -> str:
    path = resolve(args.get("path") or ".", ctx.settings.workspace)
    if not path.is_dir():
        return f"Error: folder not found: {path}"
    entries = sorted(path.iterdir(), key=lambda p: (p.is_file(), p.name.lower()))[:300]
    if not entries:
        return f"{path} is empty."
    return f"{path}:\n" + "\n".join(
        f"  {e.name}/" if e.is_dir() else f"  {e.name}  ({e.stat().st_size} bytes)" for e in entries
    )


def _search(root, pattern: str, glob: str, limit: int = 80) -> list[str]:
    try:
        rx = re.compile(pattern, re.I)
    except re.error:
        rx = re.compile(re.escape(pattern), re.I)
    hits: list[str] = []
    for path in root.rglob(glob or "*"):
        if len(hits) >= limit:
            break
        if any(part.startswith(".") or part in ("node_modules", "__pycache__") for part in path.relative_to(root).parts):
            continue
        if not path.is_file() or path.stat().st_size > 2_000_000:
            continue
        if rx.search(path.name):
            hits.append(f"{path.relative_to(root)}  (name)")
            continue
        try:
            for number, line in enumerate(path.open(encoding="utf-8", errors="strict"), 1):
                if rx.search(line):
                    hits.append(f"{path.relative_to(root)}:{number}: {line.strip()[:160]}")
                    if len(hits) >= limit:
                        break
        except (UnicodeDecodeError, OSError):
            continue
    return hits


async def search_files(args: dict, ctx: ToolContext) -> str:
    pattern = str(args.get("pattern", "")).strip()
    if not pattern:
        return "Error: say what to look for"
    root = resolve(args.get("path") or ".", ctx.settings.workspace)
    if not root.is_dir():
        return f"Error: folder not found: {root}"
    hits = await asyncio.to_thread(_search, root, pattern, str(args.get("glob") or ""))
    return f"In {root}:\n" + "\n".join(hits) if hits else f"Nothing matching {pattern!r} in {root}."


async def run_shell(args: dict, ctx: ToolContext) -> str:
    command = str(args.get("command", "")).strip()
    if not command:
        return "Error: no command given"
    cwd = resolve(args.get("cwd") or ".", ctx.settings.workspace)
    cwd.mkdir(parents=True, exist_ok=True)
    timeout = min(float(args.get("timeout") or 120), 1800)
    code, output = await run_process(command, cwd, timeout)
    return report(code, output, timeout, ctx.settings.tool_output_chars)


async def run_python(args: dict, ctx: ToolContext) -> str:
    code = str(args.get("code", ""))
    if not code.strip():
        return "Error: no code given"
    ctx.settings.workspace.mkdir(parents=True, exist_ok=True)
    timeout = min(float(args.get("timeout") or 120), 1800)
    with tempfile.NamedTemporaryFile("w", suffix=".py", delete=False) as f:
        f.write(code)
    try:
        status, output = await run_process([sys.executable, f.name], ctx.settings.workspace, timeout)
    finally:
        os.unlink(f.name)
    return report(status, output, timeout, ctx.settings.tool_output_chars)


def _status() -> str:
    mem = psutil.virtual_memory()
    disk = psutil.disk_usage("/")
    load = " ".join(f"{x:.2f}" for x in os.getloadavg()) if hasattr(os, "getloadavg") else "n/a"
    up = int(time.time() - psutil.boot_time())
    lines = [
        f"{platform.node()}: {platform.system()} {platform.release()}, Python {platform.python_version()}",
        f"up {up // 86400}d {up % 86400 // 3600}h {up % 3600 // 60}m, load {load}",
        f"cpu {psutil.cpu_percent(interval=0.5):.0f}% of {psutil.cpu_count()} cores",
        f"memory {mem.used / 1024**3:.1f} of {mem.total / 1024**3:.1f} GB used ({mem.percent:.0f}%)",
        f"disk / {disk.used / 1024**3:.0f} of {disk.total / 1024**3:.0f} GB used ({disk.percent:.0f}%)",
    ]
    return "\n".join(lines)


async def server_status(args: dict, ctx: ToolContext) -> str:
    return await asyncio.to_thread(_status)


async def list_processes(args: dict, ctx: ToolContext) -> str:
    wanted = str(args.get("name", "")).lower()
    rows = []
    for proc in psutil.process_iter(["pid", "name", "memory_info"]):
        name = proc.info["name"] or ""
        if wanted and wanted not in name.lower():
            continue
        memory = proc.info["memory_info"].rss if proc.info["memory_info"] else 0
        rows.append((memory, proc.info["pid"], name))
    if not rows:
        return f"No running program has {wanted!r} in its name." if wanted else "No programs found."
    rows.sort(reverse=True)
    lines = [f"{pid:>7}  {memory / 1024**2:>8.0f} MB  {name}" for memory, pid, name in rows[:40]]
    more = f"\n... and {len(rows) - 40} more, pass name to narrow it down" if len(rows) > 40 else ""
    return "    pid     memory  name\n" + "\n".join(lines) + more


def _protected() -> set[int]:
    """Anexis itself and its parents. Ending those would end this conversation."""
    out, proc = set(), psutil.Process()
    while proc is not None and len(out) < 4:
        out.add(proc.pid)
        proc = proc.parent()
    return out


async def end_process(args: dict, ctx: ToolContext) -> str:
    try:
        pid = int(args["pid"]) if args.get("pid") not in (None, "") else None
    except (TypeError, ValueError):
        pid = None
    name = str(args.get("name", "")).strip().lower()
    if pid is None and not name:
        return "Error: give a pid from list_processes, or an exact program name"
    targets = [
        p for p in psutil.process_iter(["pid", "name"])
        if (pid is not None and p.info["pid"] == pid) or (name and (p.info["name"] or "").lower() == name)
    ]
    if not targets:
        return "Error: no running program matches that. Call list_processes to see what is running."
    protected = _protected()
    ended, kept = [], []
    for proc in targets:
        if proc.pid in protected:
            kept.append(f"{proc.info['name']} ({proc.pid}) is Anexis itself")
            continue
        try:
            proc.terminate()
            ended.append(proc)
        except psutil.Error as e:
            kept.append(f"{proc.info['name']} ({proc.pid}): {type(e).__name__}")
    _, alive = await asyncio.to_thread(psutil.wait_procs, ended, 3)
    for proc in alive:
        try:
            proc.kill()
        except psutil.Error:
            pass
    if not ended:
        return f"Error: {'; '.join(kept)}"
    out = f"Ended {len(ended)}: " + ", ".join(f"{p.info['name']} ({p.pid})" for p in ended)
    return out + (f"\nLeft alone: {'; '.join(kept)}" if kept else "")


_PATH = text("File path. Relative paths start in the workspace folder.")

TOOLS = [
    Tool("read_file", "Read a text file on the server.", params(["path"], path=_PATH), read_file, tier=WRITE),
    Tool("write_file", "Create or overwrite a text file on the server. Set append to add to the end instead.",
         params(["path", "content"], path=_PATH, content=text("Full file content"), append={"type": "boolean"}),
         write_file, tier=WRITE),
    Tool("list_dir", "List the files and folders in a folder on the server.", params(path=_PATH), list_dir, tier=WRITE),
    Tool("search_files", "Find files by name or by text inside them, under a folder (the workspace by default).",
         params(["pattern"], pattern=text("Words or a regex to look for"), path=_PATH,
                glob=text("Only these files, like *.py or *.md")), search_files, tier=WRITE),
    Tool("run_shell", "Run a shell command (sh) on the server and get its output.",
         params(["command"], command=text("The command"), cwd=text("Folder to run in, default is the workspace"),
                timeout={"type": "number", "description": "Seconds before it is stopped, default 120"}),
         run_shell, tier=DANGER),
    Tool("run_python", "Run a Python script on the server and return what it prints.",
         params(["code"], code=text("Python source"), timeout={"type": "number"}), run_python, tier=DANGER),
    Tool("server_status", "How the server is doing: uptime, load, CPU, memory and disk.", params(), server_status, tier=SAFE),
    Tool("list_processes", "List the programs running on the server with their pid and memory. Pass name to filter.",
         params(name=text("Part of a program name")), list_processes, tier=SAFE),
    Tool("end_process", "End a running program on the server by pid or by exact name.",
         params(pid={"type": "number"}, name=text("Exact program name")), end_process, tier=DANGER),
]
