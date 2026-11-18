"""The code_task tool: real coding work in a project folder in the workspace.

Claude Code does it when it is installed on the server and signed in. When it
is not there, not signed in, or out of usage, Anexis's own coder (the coder
model plus file and shell tools fenced to the project folder) does it instead.
Nothing here needs a key to work.
"""

from __future__ import annotations

import json
import os
import re
import shutil
import time
from dataclasses import dataclass, field
from datetime import datetime, timedelta
from pathlib import Path
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from anexis.llm import AllProvidersFailed, ProviderError
from anexis.proc import report, run_process, tool_path
from anexis.tools.base import DANGER, Tool, ToolContext, params, text

# ---- Claude Code ------------------------------------------------------------

RESTING_KEY = "claude_resting_until"
LIMIT_CATEGORIES = {"rate_limit", "billing_error", "overloaded"}
LIMIT = re.compile(
    r"usage limit|rate limit|rate_limit|hit your (?:[\w-]+ )?limit|limit reached|out of (extra )?usage|"
    r"credit balance|billing_error|quota exceeded|insufficient (credits|funds)",
    re.IGNORECASE,
)
AUTH = re.compile(r"invalid api key|/login|not logged in|authentication_failed|unauthorized", re.IGNORECASE)
ALLOWED_TOOLS = "Bash,Read,Edit,Write,Glob,Grep,WebFetch,WebSearch"


@dataclass
class ClaudeResult:
    ok: bool
    text: str = ""
    limited: bool = False
    reset_at: float | None = None
    error: str = ""


def parse_reset(said: str) -> float | None:
    """When Claude says usage comes back, as a timestamp. None if it does not say."""
    stamp = re.search(r"\|(\d{10})\b", said)
    if stamp:
        return float(stamp.group(1))
    clock = re.search(r"resets?\s*(?:at\s*)?(\d{1,2})(?::(\d{2}))?\s*(am|pm)(?:\s*\(([\w/+-]+)\))?", said, re.I)
    if not clock:
        return None
    hour = int(clock.group(1)) % 12 + (12 if clock.group(3).lower() == "pm" else 0)
    zone = None
    if clock.group(4):
        try:
            zone = ZoneInfo(clock.group(4))
        except (ZoneInfoNotFoundError, ValueError):
            zone = None
    now = datetime.now(zone) if zone else datetime.now().astimezone()
    target = now.replace(hour=hour, minute=int(clock.group(2) or 0), second=0, microsecond=0)
    if target <= now:
        target += timedelta(days=1)
    return target.timestamp()


def _envelope(output: str) -> dict | None:
    """The result object Claude prints, found even with other lines around it."""
    for line in reversed(output.strip().splitlines()):
        line = line.strip()
        if line.startswith("{"):
            try:
                data = json.loads(line)
            except ValueError:
                continue
            if isinstance(data, dict) and ("result" in data or data.get("type") == "result"):
                return data
    return None


def classify(code: int, output: str) -> ClaudeResult:
    """How a Claude Code run really ended. Exit codes alone are not trusted."""
    envelope = _envelope(output)
    if envelope is None:
        said = output.strip()[-400:] or f"exit code {code}"
        if LIMIT.search(said):
            return ClaudeResult(False, limited=True, reset_at=parse_reset(said), error=said)
        return ClaudeResult(False, error=f"Claude Code failed: {said}")
    result = str(envelope.get("result") or "")
    category = str(envelope.get("error") or "")
    subtype = str(envelope.get("subtype") or "")
    if code != 0 or envelope.get("is_error") or subtype.startswith("error"):
        said = result or category or subtype or f"exit code {code}"
        if category in LIMIT_CATEGORIES or LIMIT.search(f"{result} {category}"):
            return ClaudeResult(False, limited=True, reset_at=parse_reset(result), error=said)
        if AUTH.search(f"{result} {category}"):
            return ClaudeResult(False, error=f"Claude Code is not signed in ({said[:200]})")
        return ClaudeResult(False, error=f"Claude Code failed: {said[:400]}")
    if len(result) < 200 and LIMIT.search(result):  # a "fine" run whose whole answer is the limit notice
        return ClaudeResult(False, limited=True, reset_at=parse_reset(result), error=result)
    return ClaudeResult(True, text=result)


class ClaudeRunner:
    def __init__(self, settings, memory):
        self.settings = settings
        self.memory = memory

    def installed(self) -> bool:
        return bool(shutil.which(self.settings.claude_bin, path=tool_path()))

    def available(self) -> tuple[bool, str]:
        if not self.installed():
            return False, "Claude Code is not installed on the server"
        until = self.memory.kv_get(RESTING_KEY, 0)
        if until and time.time() < until:
            return False, f"Claude is out of usage until {time.strftime('%H:%M', time.localtime(until))}"
        return True, ""

    async def run(self, task: str, cwd: Path, guidance: str = "") -> ClaudeResult:
        command = [self.settings.claude_bin, "-p", task, "--output-format", "json",
                   "--permission-mode", "acceptEdits", "--allowedTools", ALLOWED_TOOLS]
        if self.settings.claude_model:
            command += ["--model", self.settings.claude_model]
        if guidance:
            command += ["--append-system-prompt", guidance]
        env = dict(os.environ)
        env["PATH"] = tool_path()
        if self.settings.env.get("ANTHROPIC_API_KEY"):
            env["ANTHROPIC_API_KEY"] = self.settings.env["ANTHROPIC_API_KEY"]
        try:
            code, output = await run_process(command, cwd, self.settings.claude_timeout, env=env)
        except OSError as e:
            return ClaudeResult(False, error=f"Claude Code could not start ({e})")
        if code is None:
            return ClaudeResult(False, error=f"Claude ran longer than {self.settings.claude_timeout:g} seconds and was stopped")
        result = classify(code, output)
        if result.limited:
            result.reset_at = result.reset_at or time.time() + self.settings.claude_backoff_minutes * 60
            self.memory.kv_set(RESTING_KEY, result.reset_at)
            self.memory.log("claude_limit", {"until": result.reset_at, "said": result.error[:200]})
        return result


# ---- Anexis's own coder -----------------------------------------------------

REFERENCE_TOOLS = ("github_search_repos", "github_search_code", "github_read_file", "web_search", "web_fetch")
REFERENCE_SOURCES = ("mcp:docs", "mcp:deepwiki")

# The owner approved work inside the project folder, not these.
NOT_ALLOWED = [
    r"\bsudo\b", r"\bsu\s", r"\bgit\s+push\b", r"\|\s*(ba|z)?sh\b", r"\bmkfs", r"\bdd\s+if=",
    r"\b(shutdown|reboot|halt|poweroff)\b", r">\s*/dev/", r":\(\)\s*\{",
    r"\brm\s+(-\w+\s+)*(/|~|\$HOME|\.\.)", r"\b(ssh|scp|rsync)\b", r"\b(npm\s+publish|twine\s+upload)\b",
    r"\bcrontab\b", r"\bsystemctl\b",
]

CODER_SYSTEM = """You are a careful software engineer working alone inside one project folder on a server. The task comes from the owner of this server.

Work in small steps: look at what already exists, look up reference code or documentation when you are not sure how something is done, write the files, run them or their tests, and fix what fails. All file paths are relative to the project folder and you cannot leave it.

When you are finished, reply without calling a tool: say what you built, how to run it, and anything that does not work yet. Never say something works unless you ran it and saw it work.
{guidance}"""


@dataclass
class CodeResult:
    ok: bool
    text: str
    files: list[str] = field(default_factory=list)
    model: str = ""


class OwnCoder:
    def __init__(self, settings, memory, router, registry):
        self.settings = settings
        self.memory = memory
        self.router = router
        self.registry = registry

    def _tools(self, project: Path, written: list[str]) -> dict[str, Tool]:
        root = project.resolve()

        def locate(raw) -> Path | None:
            given = Path(str(raw or "."))
            path = given.resolve() if given.is_absolute() else (root / given).resolve()
            return path if path.is_relative_to(root) else None

        outside = "Error: that path is outside the project folder, which is not allowed."

        async def list_dir(args, ctx):
            path = locate(args.get("path"))
            if path is None:
                return outside
            if not path.is_dir():
                return "Error: no such folder"
            return "\n".join(sorted(p.name + ("/" if p.is_dir() else "") for p in path.iterdir())[:300]) or "(empty)"

        async def read_file(args, ctx):
            path = locate(args.get("path"))
            if path is None:
                return outside
            if not path.is_file():
                return "Error: file not found"
            return path.read_text(errors="replace")[:60_000]

        async def write_file(args, ctx):
            path = locate(args.get("path"))
            if path is None or path == root:
                return outside
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(str(args.get("content", "")))
            relative = str(path.relative_to(root))
            if relative not in written:
                written.append(relative)
            return f"Wrote {relative}"

        async def run(args, ctx):
            command = str(args.get("command", "")).strip()
            if not command:
                return "Error: no command given"
            if any(re.search(pattern, command) for pattern in NOT_ALLOWED):
                return "Error: that command is not allowed here. Stay inside the project folder, no sudo, no pushing, no piping downloads into a shell."
            timeout = min(float(args.get("timeout") or 120), 600)
            code, output = await run_process(command, root, timeout)
            return report(code, output, timeout, self.settings.tool_output_chars)

        path_arg = text("Path relative to the project folder")
        own = [
            Tool("list_dir", "List files in the project folder.", params(path=path_arg), list_dir),
            Tool("read_file", "Read a file in the project.", params(["path"], path=path_arg), read_file),
            Tool("write_file", "Create or overwrite a file in the project. Always send the full content.",
                 params(["path", "content"], path=path_arg, content=text("Full file content")), write_file),
            Tool("run", "Run a shell command in the project folder, for example tests or the program itself.",
                 params(["command"], command=text("The command"), timeout={"type": "number"}), run),
        ]
        tools = {t.name: t for t in own}
        for candidate in self.registry.all():
            if candidate.name in REFERENCE_TOOLS or candidate.source in REFERENCE_SOURCES:
                tools.setdefault(candidate.name, candidate)
        return tools

    async def run(self, task: str, project: Path, guidance: str = "") -> CodeResult:
        written: list[str] = []
        tools = self._tools(project, written)
        schemas = [t.schema() for t in tools.values()]
        ctx = ToolContext(settings=self.settings, memory=self.memory, router=self.router,
                          registry=self.registry, session_id="coder")
        messages = [
            {"role": "system", "content": CODER_SYSTEM.format(guidance=guidance)},
            {"role": "user", "content": f"Project folder: {project}\n\nTask:\n{task}"},
        ]
        model = ""
        try:
            for _ in range(self.settings.fallback_rounds):
                reply = await self.router.chat("coder", messages, schemas)
                model = f"{reply.provider}:{reply.model}"
                if not reply.tool_calls:
                    return CodeResult(True, reply.content, written, model)
                messages.append(reply.message())
                for tool_call in reply.tool_calls:
                    tool = tools.get(tool_call.name)
                    if tool is None:
                        output = f"Error: no tool named {tool_call.name}"
                    else:
                        try:
                            output = str(await tool.handler(tool_call.arguments, ctx))
                        except Exception as e:
                            output = f"Error: {type(e).__name__}: {e}"
                    messages.append({"role": "tool", "tool_call_id": tool_call.id,
                                     "content": output[: self.settings.tool_output_chars]})
        except (AllProvidersFailed, ProviderError) as e:
            return CodeResult(False, f"No model could do the coding. {e}", written, model)
        return CodeResult(
            False,
            f"Stopped after {self.settings.fallback_rounds} rounds without finishing. "
            f"Files written so far: {', '.join(written) or 'none'}.",
            written, model,
        )


# ---- the tool ---------------------------------------------------------------

def project_dir(settings, name: str) -> Path:
    """Every project lives in its own folder directly under the workspace."""
    slug = re.sub(r"[^a-z0-9]+", "-", str(name).lower()).strip("-")[:60] or "project"
    return settings.workspace / slug


def _guidance(memory, task: str) -> str:
    """What the owner has said about how they like their code."""
    found = memory.search(f"code coding programming style {task}", k=8)
    lines = [m.text for m in found if m.kind in ("lesson", "preference")][:5]
    if not lines:
        return ""
    return "The owner's standing preferences:\n" + "\n".join(f"- {line}" for line in lines)


def make_code_tool(claude: ClaudeRunner, own: OwnCoder) -> Tool:
    async def code_task(args: dict, ctx: ToolContext) -> str:
        task = str(args.get("task", "")).strip()
        if not task:
            return "Error: describe what to build"
        project = project_dir(ctx.settings, args.get("project") or "project")
        project.mkdir(parents=True, exist_ok=True)
        guidance = _guidance(ctx.memory, task)

        usable, why_not = claude.available()
        if usable:
            ctx.emit({"type": "status", "text": "Claude Code is coding..."})
            result = await claude.run(task, project, guidance)
            if result.ok:
                return f"Written by: Claude Code\nProject folder: {project}\n\n{result.text}"
            if result.limited:
                why_not = f"Claude is out of usage until {time.strftime('%H:%M', time.localtime(result.reset_at))}"
            else:
                why_not = result.error

        ctx.emit({"type": "status", "text": f"{why_not}. Coding it myself..."})
        done = await own.run(task, project, guidance)
        if not done.ok:
            return f"Error: the coding task did not finish.\nClaude: {why_not}\nMy own coder: {done.text}\nProject folder: {project}"
        files = f"\nFiles: {', '.join(done.files)}" if done.files else ""
        return (f"Written by: Anexis's own coder ({done.model}), because {why_not}.\n"
                f"Project folder: {project}{files}\n\n{done.text}")

    return Tool(
        "code_task",
        "Build or change software: write a program, script, app, fix a bug, add a feature. "
        "Hands the job to a coding agent that works in its own project folder on the server, writes files and runs them. "
        "Use this for any real coding work instead of writing code in the chat. Always tell the owner who wrote the code, as stated in the result.",
        params(["project", "task"],
               project=text("Short project name. Reuse the same name to keep working on a project."),
               task=text("Everything the coder needs: what to build, language, inputs, outputs, how to check it works.")),
        code_task,
        tier=DANGER,
    )
