"""The `anexis` command (also installed as `jarvis`).

    anexis                 chat (starts the server in the background if needed)
    anexis ask <words>     one question, one answer, for scripts
    anexis doctor          check every part
    anexis tools           list every tool
    anexis watch           what Anexis is doing, live, from another terminal
    anexis start | stop | restart | status
    anexis serve           run the server in this terminal (what systemd runs)
"""

from __future__ import annotations

import argparse
import asyncio
import inspect
import os
import sys
import time
from pathlib import Path

import httpx
from rich.console import Console
from rich.markup import escape

from anexis.cli.client import AnexisClient
from anexis.config import Settings, load_settings
from anexis.proc import is_anexis_server, start_detached, stop_process

console = Console()


def pid_file(settings: Settings) -> Path:
    return settings.home / "server.pid"


def server_pid(settings: Settings) -> int | None:
    """The running server's pid, only when that process really is our server."""
    try:
        pid = int(pid_file(settings).read_text().strip())
    except (OSError, ValueError):
        return None
    return pid if is_anexis_server(pid) else None


async def is_up(client: AnexisClient) -> bool:
    try:
        await client.health()
        return True
    except (httpx.HTTPError, OSError, ValueError):
        return False


async def start_server(settings: Settings, quiet: bool = False) -> AnexisClient:
    """The server, started in the background when it is not running yet."""
    client = AnexisClient(settings.url)
    if await is_up(client):
        return client
    settings.home.mkdir(parents=True, exist_ok=True)
    start_detached([sys.executable, "-m", "anexis", "serve"], settings.home / "server.log")
    if not quiet:
        console.print("[dim]  starting anexis...[/dim]")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        if await is_up(client):
            return client
    log = settings.home / "server.log"
    tail = log.read_text(errors="replace").strip().splitlines()[-8:] if log.is_file() else []
    sys.exit("  anexis did not come up. Last lines of " + str(log) + ":\n" + "\n".join("    " + t for t in tail))


def stop_server(settings: Settings) -> bool:
    pid = server_pid(settings)
    pid_file(settings).unlink(missing_ok=True)
    if pid is None:
        return False
    stop_process(pid)
    return True


# ---- commands ---------------------------------------------------------------

def cmd_serve(settings: Settings, args) -> None:
    import uvicorn

    from anexis.app import AnexisApp
    from anexis.server import create_app

    running = server_pid(settings)
    if running and running != os.getpid():
        sys.exit(f"  anexis is already running (pid {running}). Use anexis restart.")
    settings.home.mkdir(parents=True, exist_ok=True)
    pid_file(settings).write_text(str(os.getpid()))
    app = create_app(AnexisApp(settings))
    try:
        uvicorn.run(app, host=settings.host, port=settings.port, log_level="warning", timeout_graceful_shutdown=3)
    finally:
        try:
            if pid_file(settings).read_text().strip() == str(os.getpid()):
                pid_file(settings).unlink()
        except OSError:
            pass


async def cmd_chat(settings: Settings, args) -> None:
    from anexis.cli.chat import run_chat

    await run_chat(await start_server(settings), settings.home)


async def cmd_ask(settings: Settings, args) -> None:
    from anexis.cli.chat import ChatSession

    async def no(question: str) -> bool:
        console.print(f"{question}no (use the chat to allow things)", markup=False, highlight=False)
        return False

    chat = ChatSession(await start_server(settings, quiet=True), console, no)
    await chat.send(" ".join(args.text))


async def cmd_doctor(settings: Settings, args) -> None:
    from anexis.cli.chat import show_doctor

    client = await start_server(settings)
    for _ in range(120):  # let tool servers finish their first start
        if not (await client.health()).get("tool_servers_starting"):
            break
        await asyncio.sleep(1)
    if not show_doctor(console, await client.doctor()):
        sys.exit(1)


async def cmd_tools(settings: Settings, args) -> None:
    from anexis.cli.chat import show_tools

    show_tools(console, await (await start_server(settings)).tools())


async def cmd_watch(settings: Settings, args) -> None:
    client = await start_server(settings)
    console.print("[dim]  watching. ctrl+c to leave.[/dim]")
    async for event in client.events():
        if event.get("type") != "activity":
            continue
        when = time.strftime("%H:%M:%S", time.localtime(event.get("at", time.time())))
        args_text = " ".join(f"{k}={v}" for k, v in (event.get("args") or {}).items())[:100]
        console.print(f"  [dim]{when}[/dim] {event['status']:<9} [bold]{escape(event['tool'])}[/bold] [dim]{escape(args_text)}[/dim]",
                      highlight=False)


async def cmd_start(settings: Settings, args) -> None:
    await start_server(settings)
    console.print(f"  anexis is running on {settings.url}")


async def cmd_status(settings: Settings, args) -> None:
    from anexis.cli.chat import header

    client = AnexisClient(settings.url)
    if not await is_up(client):
        console.print("  anexis is not running. anexis start, or just anexis to chat.")
        return
    console.print(f"  {escape(header(await client.health()))}", highlight=False)


def cmd_stop(settings: Settings, args) -> None:
    console.print("  stopped." if stop_server(settings) else "  anexis was not running.")


async def cmd_restart(settings: Settings, args) -> None:
    stop_server(settings)
    await start_server(settings)
    console.print("  restarted.")


COMMANDS = {
    "chat": (cmd_chat, "talk to Anexis (the default)"),
    "ask": (cmd_ask, "one question, one answer"),
    "doctor": (cmd_doctor, "check that every part works"),
    "tools": (cmd_tools, "list every tool"),
    "watch": (cmd_watch, "show what Anexis is doing, live"),
    "start": (cmd_start, "start the server in the background"),
    "stop": (cmd_stop, "stop the server"),
    "restart": (cmd_restart, "stop, then start again (after editing .env or anexis.toml)"),
    "status": (cmd_status, "is it running, on which model"),
    "serve": (cmd_serve, "run the server in this terminal (for systemd)"),
}


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="anexis", description="Anexis, your assistant on this server.")
    sub = parser.add_subparsers(dest="command")
    for name, (_, about) in COMMANDS.items():
        p = sub.add_parser(name, help=about)
        if name == "ask":
            p.add_argument("text", nargs="+")
    args = parser.parse_args(argv)
    settings = load_settings()
    run, _ = COMMANDS[args.command or "chat"]
    try:
        if inspect.iscoroutinefunction(run):
            asyncio.run(run(settings, args))
        else:
            run(settings, args)
    except KeyboardInterrupt:
        pass
