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
from anexis.proc import describe, is_anexis_server, port_owner, start_detached, stop_process

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


async def probe(client: AnexisClient) -> str:
    """"ours" when this edition answers, "other" when something else answers on
    the port (like an older Anexis that wants a token), "none" when nothing does."""
    try:
        health = await client.health()
    except httpx.HTTPStatusError:
        return "other"
    except (httpx.HTTPError, OSError, ValueError):
        return "none"
    return "ours" if isinstance(health, dict) and health.get("edition") == "server" else "other"


async def is_up(client: AnexisClient) -> bool:
    return await probe(client) == "ours"


def clear_port(settings: Settings) -> None:
    """Makes the port free for this edition. An older Anexis on it is stopped
    (its pid file may be long gone, so it is found by the port). Anything else
    is left alone and explained, never crashed into."""
    holder = port_owner(settings.port)
    if holder is None:
        return
    if is_anexis_server(holder):
        stop_process(holder)
        console.print(f"[dim]  stopped an older anexis (pid {holder}) that was using port {settings.port}[/dim]")
        return
    sys.exit(f"  port {settings.port} is already used by another program (pid {holder}: {describe(holder)}).\n"
             f"  Stop that program, or give anexis another port: put ANEXIS_PORT={settings.port + 1} in ~/.anexis/.env")


async def start_server(settings: Settings, quiet: bool = False) -> AnexisClient:
    """The server, started in the background when it is not running yet."""
    client = AnexisClient(settings.url)
    state = await probe(client)
    if state == "none" and port_owner(settings.port):
        # Something is on the port but not answering yet: maybe it is still starting.
        for _ in range(30):
            await asyncio.sleep(0.5)
            state = await probe(client)
            if state != "none":
                break
    if state == "ours":
        return client
    clear_port(settings)
    if state == "other" and port_owner(settings.port) is None and await probe(client) == "other":
        sys.exit(f"  port {settings.port} answers, but not as this anexis, and its program cannot be seen.\n"
                 f"  Stop it, or give anexis another port: put ANEXIS_PORT={settings.port + 1} in ~/.anexis/.env")

    settings.home.mkdir(parents=True, exist_ok=True)
    log = settings.home / "server.log"
    start = log.stat().st_size if log.is_file() else 0
    start_detached([sys.executable, "-m", "anexis", "serve"], log)
    if not quiet:
        console.print("[dim]  starting anexis...[/dim]")
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        await asyncio.sleep(0.5)
        if await is_up(client):
            return client
    with open(log, errors="replace") as f:  # only what this start wrote, not old history
        f.seek(start)
        tail = f.read().strip().splitlines()[-8:]
    sys.exit(f"  anexis did not come up. It said ({log}):\n" + "\n".join("    " + t for t in tail))


def stop_server(settings: Settings) -> bool:
    """Stops this machine's anexis server: the one in the pid file, and any
    anexis holding the port (an older one whose pid file is gone)."""
    found = {pid for pid in (server_pid(settings), port_owner(settings.port)) if pid and is_anexis_server(pid)}
    pid_file(settings).unlink(missing_ok=True)
    for pid in found:
        stop_process(pid)
    return bool(found)


# ---- commands ---------------------------------------------------------------

def cmd_serve(settings: Settings, args) -> None:
    import uvicorn

    from anexis.app import AnexisApp
    from anexis.server import create_app

    running = server_pid(settings)
    if (running and running != os.getpid()) or asyncio.run(is_up(AnexisClient(settings.url))):
        sys.exit("  anexis is already running. Use anexis restart.")
    clear_port(settings)  # an older anexis on the port is stopped, anything else is explained
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
