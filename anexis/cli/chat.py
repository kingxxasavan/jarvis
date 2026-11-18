"""The terminal chat. Plain on purpose: a one line status, your words after a
`>`, Anexis's answer indented under it, tool calls in grey.

    anexis · nvidia llama-3.3-70b · 42 memories · 31 tools · ask
    due soon: Chem lab writeup (due 2026-11-20 23:59)
    /help for commands · ctrl+c stops a reply · ctrl+d quits

    > whats due this week
      [tool] list_items type=assignment
      Two things. The chem lab is due Thursday and ...
      2.4s · list_items · 3 memories
"""

from __future__ import annotations

import asyncio
import time
from collections.abc import Awaitable, Callable
from pathlib import Path

import httpx
from rich.console import Console
from rich.markup import escape

from anexis.agent import MODES
from anexis.cli.client import AnexisClient

PAD = "  "
HELP = """
  /new                 start a fresh chat (I still remember you)
  /chats               your recent chats
  /open <n>            go back to chat number n from /chats
  /clear               delete this chat (what I learned stays)
  /mode <name>         general, school, work or project
  /memory [words]      what I remember, or search it
  /remember <text>     save something on purpose
  /pin <text>          save something that is always true about you
  /forget <n>          delete memory number n
  /why                 the memories behind my last answer
  /tools               tool servers and how many tools each has
  /code <what>         build something in the workspace
  /doctor              check every part
  /quit                leave (ctrl+d works too)
"""


def parse_command(line: str) -> tuple[str | None, str]:
    line = line.strip()
    if not line.startswith("/") or len(line) < 2:
        return None, line
    name, _, arg = line[1:].partition(" ")
    return name.lower(), arg.strip()


def short_args(args: dict, limit: int = 90) -> str:
    out = " ".join(f"{k}={' '.join(str(v).split())}" for k, v in args.items())
    return out if len(out) <= limit else out[: limit - 3] + "..."


def header(health: dict, mode: str | None = None) -> str:
    providers = health.get("providers") or []
    if providers:
        first = providers[0]
        model = health.get("chat_models", {}).get(first, "")
        brain = f"{first} {model.rsplit('/', 1)[-1]}".strip()
    else:
        brain = "no model yet"
    parts = [health.get("name", "Anexis").lower(), brain, f"{health.get('memories', 0)} memories",
             f"{health.get('tools', 0)} tools", health.get("control", "ask")]
    if mode and mode != "general":
        parts.append(mode)
    return " · ".join(parts)


class ChatSession:
    """One conversation with the server. Printing and asking are passed in, so
    the same code drives the real terminal and the tests."""

    def __init__(self, client: AnexisClient, console: Console, yes_no: Callable[[str], Awaitable[bool]]):
        self.client = client
        self.console = console
        self.yes_no = yes_no
        self.session_id: str | None = None
        self.mode: str | None = None
        self._listed: list[dict] = []

    def say(self, text: str, style: str = "dim") -> None:
        self.console.print(f"[{style}]{PAD}{escape(text)}[/{style}]", highlight=False)

    async def send(self, text: str) -> str:
        reply: list[str] = []
        started = time.monotonic()
        mid_line = False
        waiting = self.console.status("[dim]thinking[/dim]", spinner="dots")
        waiting.start()

        def settle() -> None:
            nonlocal mid_line
            waiting.stop()
            if mid_line:
                self.console.print()
                mid_line = False

        try:
            async for event in self.client.chat(text, self.session_id, self.mode):
                kind = event["type"]
                if kind == "text":
                    waiting.stop()
                    piece = event["delta"]
                    if not mid_line:
                        self.console.print(PAD, end="")
                        mid_line = True
                        piece = piece.lstrip("\n")
                    reply.append(piece)
                    self.console.print(piece.replace("\n", "\n" + PAD), end="", markup=False, highlight=False, soft_wrap=True)
                elif kind == "tool" and event.get("status") == "running":
                    settle()
                    self.say(f"[tool] {event['name']} {short_args(event['args'])}".rstrip())
                    waiting.start()
                elif kind == "confirm":
                    settle()
                    self.say(f"? {event['tool']} wants to run: {short_args(event['args'], 300)}", "yellow")
                    if event.get("reason"):
                        self.say(f"  because it {event['reason']}")
                    allowed = await self.yes_no(f"{PAD}  allow? y/N ")
                    await self.client.confirm(event["id"], allowed)
                    if allowed:
                        waiting.start()
                elif kind == "tool_result" and not event.get("ok"):
                    settle()
                    self.say(f"  {event['name']} failed: {event.get('preview', '')[:140]}", "red")
                    waiting.start()
                elif kind == "status":
                    settle()
                    self.say(event["text"])
                    waiting.start()
                elif kind == "done":
                    settle()
                    self.session_id = event["session_id"]
                    notes = [f"{time.monotonic() - started:.1f}s", *sorted(set(event.get("tools_used") or []))]
                    if event.get("memories_used"):
                        notes.append(f"{len(event['memories_used'])} memories")
                    self.say(" · ".join(notes))
                elif kind == "error":
                    settle()
                    self.say(f"! {event['message']}", "red")
                elif kind == "stopped":
                    settle()
        except (httpx.HTTPError, OSError) as e:
            settle()
            self.say(f"! lost the server: {e or type(e).__name__}. Run anexis again to restart it.", "red")
        finally:
            settle()
        return "".join(reply)

    def _memories(self, rows: list[dict], empty: str) -> None:
        if not rows:
            self.say(empty)
        for m in rows:
            pin = " [dim](always)[/dim]" if m.get("pinned") else ""
            self.console.print(f"{PAD}[dim]#{m['id']:<5}{m['kind']:<11}[/dim]{escape(m['text'])}{pin}", highlight=False)

    async def command(self, name: str, arg: str) -> bool:
        """Runs a slash command. False means quit."""
        c = self.client
        if name in ("quit", "exit", "q"):
            return False
        if name in ("help", "h", "?"):
            self.console.print(HELP, style="dim", highlight=False)
        elif name == "new":
            self.session_id = None
            self.say("fresh chat. I still remember you.")
        elif name == "chats":
            self._listed = await c.sessions()
            if not self._listed:
                self.say("no chats yet.")
            for n, s in enumerate(self._listed[:15], 1):
                when = time.strftime("%b %d %H:%M", time.localtime(s["updated_at"]))
                self.console.print(f"{PAD}[dim]{n:>2}  {when}[/dim]  {escape(s['title'])}", highlight=False)
        elif name == "open":
            if not arg.isdigit() or not 0 < int(arg) <= len(self._listed):
                self.say("usage: /chats first, then /open <number>")
            else:
                chosen = self._listed[int(arg) - 1]
                self.session_id = chosen["id"]
                for m in (await c.messages(chosen["id"]))[-6:]:
                    who = ">" if m["role"] == "user" else " "
                    self.console.print(f"[dim]{who} {escape(' '.join(m['content'].split())[:200])}[/dim]", highlight=False)
                self.say(f"back in: {chosen['title']}")
        elif name == "clear":
            if self.session_id:
                await c.clear(self.session_id)
            self.session_id = None
            self.say("cleared. what I learned from it stays.")
        elif name == "mode":
            if arg in MODES:
                self.mode = arg
                self.say(f"mode is {arg} now.")
            else:
                self.say(f"modes: {', '.join(MODES)}")
        elif name == "memory":
            self._memories(await c.memories(arg), "nothing found." if arg else "nothing remembered yet.")
        elif name in ("remember", "pin"):
            if arg:
                saved = await c.remember(arg, pinned=name == "pin")
                self.say(f"saved as #{saved['id']}.")
            else:
                self.say(f"usage: /{name} <something about you>")
        elif name == "forget":
            if arg.lstrip("#").isdigit():
                gone = (await c.forget(int(arg.lstrip("#"))))["forgotten"]
                self.say("forgotten." if gone else "no memory with that number.")
            else:
                self.say("usage: /forget <number from /memory>")
        elif name == "why":
            rows = await c.why(self.session_id) if self.session_id else []
            self._memories(rows, "no memories were used for the last answer.")
        elif name == "tools":
            show_tools(self.console, await c.tools())
        elif name == "doctor":
            show_doctor(self.console, await c.doctor())
        elif name == "code":
            if arg:
                await self.send(f"Use the code_task tool to build this: {arg}")
            else:
                self.say("usage: /code <what to build>")
        else:
            self.say(f"no command /{name}. try /help")
        return True


def show_tools(console: Console, info: dict) -> None:
    tools = info["tools"]
    builtin = sorted(t["name"] for t in tools if t["source"] == "builtin")
    console.print(f"{PAD}[bold]built in[/bold] [dim]({len(builtin)})[/dim]", highlight=False)
    console.print(f"{PAD}[dim]{escape(', '.join(builtin))}[/dim]", highlight=False)
    if info["servers"]:
        console.print(f"\n{PAD}[bold]tool servers[/bold]", highlight=False)
    for server, s in sorted(info["servers"].items()):
        if s["state"] == "running":
            extra = f"{s['tools']} tools"
        elif s["state"] == "needs key":
            extra = "add " + ", ".join(s.get("needs") or []) + " to turn on"
        else:
            extra = s.get("error") or ""
        color = {"running": "green", "failed": "red", "starting": "yellow"}.get(s["state"], "dim")
        console.print(f"{PAD}{server:<11}[{color}]{s['state']:<10}[/{color}] [dim]{escape(extra[:100])}[/dim]", highlight=False)


def show_doctor(console: Console, checks: list[dict]) -> bool:
    """Prints the checkup. True when every required part works."""
    for c in checks:
        mark = "[green] ok [/green]" if c["ok"] else ("[yellow] -- [/yellow]" if c.get("optional") else "[red]FIX [/red]")
        console.print(f"{PAD}{mark} [bold]{escape(c['part']):<16}[/bold] {escape(c['detail'])}", highlight=False)
        if c.get("fix"):
            console.print(f"{PAD}     [dim]{'':<16} {escape(c['fix'])}[/dim]", highlight=False)
    return all(c["ok"] or c.get("optional") for c in checks)


async def run_chat(client: AnexisClient, home: Path) -> None:
    from prompt_toolkit import PromptSession
    from prompt_toolkit.history import FileHistory
    from prompt_toolkit.patch_stdout import patch_stdout

    console = Console()
    home.mkdir(parents=True, exist_ok=True)
    prompt: PromptSession = PromptSession(history=FileHistory(str(home / "chat_history")))

    async def yes_no(question: str) -> bool:
        try:
            return (await prompt.prompt_async(question)).strip().lower() in ("y", "yes")
        except (EOFError, KeyboardInterrupt):
            return False

    chat = ChatSession(client, console, yes_no)
    health = await client.health()
    console.print(f"\n[bold]{escape(header(health))}[/bold]", highlight=False)
    for warning in health.get("warnings", []):
        chat.say(warning, "yellow")
    for item in health.get("due", []):
        chat.say(f"due soon: {item}", "yellow")
    if health.get("tool_servers_starting"):
        chat.say(f"tool servers still starting: {', '.join(health['tool_servers_starting'])}")
    chat.say("/help for commands · ctrl+c stops a reply · ctrl+d quits")

    while True:
        try:
            with patch_stdout():
                line = await prompt.prompt_async("\n> ")
        except (EOFError, KeyboardInterrupt):
            break
        name, arg = parse_command(line)
        if not name and not arg:
            continue
        work = chat.command(name, arg) if name else chat.send(arg)
        turn = asyncio.ensure_future(work)
        try:
            keep_going = await asyncio.shield(turn)
            if name and not keep_going:
                break
        except (KeyboardInterrupt, asyncio.CancelledError):
            # ctrl+c: stop the work on the server too, not just the printing.
            try:
                await chat.client.stop(chat.session_id)
            except httpx.HTTPError:
                pass
            turn.cancel()
            me = asyncio.current_task()
            if me is not None and me.cancelling():
                me.uncancel()  # ctrl+c stopped the reply, not the chat
            chat.say("stopped.")
        except httpx.HTTPError as e:
            chat.say(f"! server problem: {e or type(e).__name__}", "red")
    chat.say("later.")
