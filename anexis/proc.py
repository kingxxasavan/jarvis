"""Running programs on the server, and ending them cleanly.

Every program gets its own process group, so a timeout or a stop ends
everything it started, not just the first process.
"""

from __future__ import annotations

import asyncio
import os
import shutil
import signal
import subprocess
from pathlib import Path

import psutil


def node_dir() -> Path:
    """Where install.sh puts its own Node when the system one is missing or old."""
    return Path.home() / ".local" / "share" / "anexis" / "node" / "bin"


def tool_path() -> str:
    """PATH for programs Anexis starts: its own Node first, then the usual PATH."""
    parts = [str(node_dir())] if node_dir().is_dir() else []
    parts.append(os.environ.get("PATH", ""))
    return os.pathsep.join(p for p in parts if p)


def find_program(name: str) -> str:
    if os.path.dirname(name):
        return name
    return shutil.which(name, path=tool_path()) or name


def kill_tree(pid: int) -> None:
    """Ends a program and everything it started. Never raises for one already gone."""
    try:
        parent = psutil.Process(pid)
        family = parent.children(recursive=True)
    except psutil.Error:
        parent, family = None, []
    try:
        os.killpg(pid, signal.SIGKILL)
    except (ProcessLookupError, PermissionError):
        pass
    procs = [*family, *([parent] if parent else [])]
    for proc in procs:
        try:
            proc.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(procs, timeout=5)


def stop_process(pid: int, grace: float = 10.0) -> None:
    """Asks a program to stop, and ends it for real when it does not."""
    try:
        proc = psutil.Process(pid)
        family = proc.children(recursive=True)
        proc.terminate()
        try:
            proc.wait(grace)
        except psutil.TimeoutExpired:
            kill_tree(pid)
    except psutil.Error:
        return
    for child in family:
        try:
            child.kill()
        except psutil.Error:
            pass
    psutil.wait_procs(family, timeout=5)


def is_anexis_server(pid: int) -> bool:
    """True only when that process really is `anexis serve`, so a stale pid file
    can never get some other program stopped."""
    try:
        proc = psutil.Process(pid)
        if proc.status() == psutil.STATUS_ZOMBIE:
            return False
        words = [part.rsplit("/", 1)[-1].lower() for part in proc.cmdline()]
    except psutil.Error:
        return False
    return "serve" in words and "anexis" in words


def port_owner(port: int) -> int | None:
    """The pid of the program listening on this TCP port, or None when nothing
    is (or when it belongs to another user and cannot be seen)."""
    try:
        conns = psutil.net_connections(kind="tcp")
    except (psutil.Error, OSError):
        return None
    for conn in conns:
        if conn.status == psutil.CONN_LISTEN and conn.laddr and conn.laddr.port == port and conn.pid:
            return conn.pid
    return None


def describe(pid: int) -> str:
    try:
        return " ".join(psutil.Process(pid).cmdline())[:120] or psutil.Process(pid).name()
    except psutil.Error:
        return "a program"


async def run_process(
    argv: list[str] | str, cwd, timeout: float, env: dict | None = None, stdin: bytes | None = None
) -> tuple[int | None, str]:
    """Runs a program. Returns (exit code, or None on timeout, and the combined output).
    A string is run as one line of sh."""
    argv = ["/bin/sh", "-c", argv] if isinstance(argv, str) else [find_program(str(argv[0])), *argv[1:]]
    proc = await asyncio.create_subprocess_exec(
        *argv,
        cwd=str(cwd),
        stdin=asyncio.subprocess.PIPE if stdin is not None else asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.STDOUT,
        env=env,
        start_new_session=True,
    )
    try:
        out, _ = await asyncio.wait_for(proc.communicate(stdin), timeout)
        return proc.returncode, out.decode("utf-8", errors="replace")
    except TimeoutError:
        return None, ""
    finally:
        # Timed out, or the owner pressed stop mid command: nothing is left running.
        if proc.returncode is None:
            kill_tree(proc.pid)
            await asyncio.shield(proc.wait())


def report(code: int | None, output: str, timeout: float, limit: int) -> str:
    """A command's result in the words a model reads best."""
    if code is None:
        return f"Error: timed out after {timeout:g} seconds and was stopped."
    if len(output) > limit:
        output = output[: limit // 2] + "\n... (middle cut) ...\n" + output[-limit // 2 :]
    return f"exit code {code}\n{output}".rstrip()


def start_detached(argv: list[str], log_path: Path) -> None:
    """Starts a program that keeps running after this one ends."""
    with open(log_path, "a") as log:
        subprocess.Popen(argv, stdout=log, stderr=log, stdin=subprocess.DEVNULL, start_new_session=True)
