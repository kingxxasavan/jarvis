"""Projects in the workspace folder, and building them with Codex or Claude Code."""

from __future__ import annotations

import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from ..coding import available, run_agent
from ..registry import Tool, ToolContext, schema

DENY = re.compile(r"(^|[\\/])(\.env[^\\/]*|\.git|node_modules|\.venv|id_rsa[^\\/]*|.*\.pem|.*\.key)$", re.I)

GUIDE = """You are building software for the owner of this computer, working fully on your own. Do not ask questions;
make sensible decisions and note them. Write complete, working, production-quality code
(no placeholders or TODO stubs), keep it modular and readable, and include a short README
with how to run it. If the project has a build or test command, run it and fix what fails.
Never print or commit secrets. When done, reply with a summary under 150 words: what you
built, where the main files are, and the exact command to run it.

Task:
"""


class Workspace:
    def __init__(self, root: Path, codex_bin: str = "", claude_bin: str = ""):
        self.root = root
        self.codex_bin = codex_bin
        self.claude_bin = claude_bin

    def slug(self, name: str) -> str:
        s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:60]
        if not s:
            raise ValueError("Give the project a name.")
        return s

    def project(self, name: str) -> Path:
        path = (self.root / self.slug(name)).resolve()
        if path.parent != self.root:
            raise ValueError("Projects must live directly in the workspace folder.")
        return path

    def safe_file(self, project: Path, rel: str) -> Path:
        target = (project / rel).resolve()
        if project != target and project not in target.parents:
            raise PermissionError("That path is outside the project.")
        if DENY.search(str(target)):
            raise PermissionError("That file is private (secrets, keys or dependencies) and is not read remotely.")
        return target

    # Tools -----------------------------------------------------------------------

    def list_projects(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        self.root.mkdir(parents=True, exist_ok=True)
        items = []
        for p in sorted(self.root.iterdir(), key=lambda x: x.stat().st_mtime, reverse=True):
            if p.is_dir() and not p.name.startswith("."):
                items.append({"name": p.name, "modified": datetime.fromtimestamp(p.stat().st_mtime).strftime("%Y-%m-%d %H:%M"),
                              "git": (p / ".git").exists()})
        return {"workspace": str(self.root), "projects": items[:60]}

    def read_project_file(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        project = self.project(str(args.get("project") or ""))
        if not project.is_dir():
            raise FileNotFoundError("No such project.")
        rel = str(args.get("path") or "").strip() or "."
        target = self.safe_file(project, rel)
        if target.is_dir():
            entries = sorted(
                (("dir " if c.is_dir() else "") + c.name for c in target.iterdir() if not DENY.search(c.name)),
            )
            return {"directory": rel, "entries": entries[:200]}
        if target.stat().st_size > 400_000:
            raise ValueError("That file is too large to read remotely.")
        return {"path": rel, "content": target.read_text(encoding="utf-8", errors="replace")[:20000]}

    def run_coding_agent(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        instructions = str(args.get("instructions") or "").strip()
        if len(instructions) < 10:
            raise ValueError("Describe what to build or change.")
        project = self.project(str(args.get("project") or ""))
        wanted = str(args.get("agent") or "codex").lower()
        tools = available(self.codex_bin, self.claude_bin)
        order = [wanted] + [a for a in ("codex", "claude") if a != wanted]
        agent = next((a for a in order if tools.get(a)), None)
        if not agent:
            raise RuntimeError("Neither Codex nor Claude Code is installed on this device. Install one: "
                               "`npm i -g @openai/codex` or `npm i -g @anthropic-ai/claude-code`, then sign in.")
        if agent != wanted:
            ctx.log("log", f"{wanted} is not installed here; using {agent} instead.")

        is_new = not project.exists()
        project.mkdir(parents=True, exist_ok=True)
        if not (project / ".git").exists():
            subprocess.run(["git", "init", "-q", "-b", "main"], cwd=project, capture_output=True)
        ctx.log("log", f"{'Created' if is_new else 'Working in'} {project} with {agent}.")

        result = run_agent(agent, tools[agent] or "", GUIDE + instructions, project, ctx.log, ctx.cancelled)
        commit, files = self._commit(project, str(args.get("title") or instructions[:60]))
        out: dict[str, Any] = {"project": project.name, "path": str(project), "agent": agent, "summary": result.summary,
                               "commit": commit, "files_changed": files}
        if not result.ok:
            raise RuntimeError(f"{agent} stopped: {result.error}" + (f" (work so far saved as commit {commit})" if commit else ""))
        if args.get("publish_github"):
            out["repo_url"] = self._publish(project, ctx)
        return out

    def _git(self, project: Path, *cmd: str) -> subprocess.CompletedProcess[str]:
        return subprocess.run(["git", "-c", "user.name=JARVIS", "-c", "user.email=jarvis@localhost", *cmd],
                              cwd=project, capture_output=True, text=True, encoding="utf-8", errors="replace")

    def _commit(self, project: Path, title: str) -> tuple[str | None, list[str]]:
        if not shutil.which("git"):
            return None, []
        self._git(project, "add", "-A")
        if self._git(project, "diff", "--cached", "--quiet").returncode == 0:
            return None, []
        if self._git(project, "commit", "-q", "-m", f"JARVIS: {title}"[:200]).returncode != 0:
            return None, []
        sha = self._git(project, "rev-parse", "--short", "HEAD").stdout.strip()
        files = self._git(project, "show", "--name-only", "--format=", "HEAD").stdout.split()
        return sha, files[:300]

    def _publish(self, project: Path, ctx: ToolContext) -> str:
        if not shutil.which("gh"):
            raise RuntimeError("The project is built, but GitHub CLI (gh) is not installed here, so it was not published.")
        res = subprocess.run(["gh", "repo", "create", project.name, "--private", "--source", ".", "--push"],
                             cwd=project, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=180)
        if res.returncode != 0:
            raise RuntimeError(f"Built and committed, but publishing failed: {(res.stderr or res.stdout).strip()[:400]}")
        url = next((w for w in res.stdout.split() if w.startswith("https://github.com/")), "")
        ctx.log("log", f"Published privately: {url}")
        return url

    def tools(self) -> list[Tool]:
        return [
            Tool("list_projects", "List projects in the JARVIS workspace folder on this device.", schema(), self.list_projects),
            Tool("read_project_file", "Read a file, or list a folder, inside a workspace project.",
                 schema({"project": {"type": "string"}, "path": {"type": "string", "description": "Relative path; '.' for the top folder"}},
                        ["project"]), self.read_project_file),
            Tool(
                "run_coding_agent",
                "Create or change a software project with Codex or Claude Code on this device. They write the code, run builds "
                "and tests, and the result is committed to git so it can be undone. Use for any real coding work.",
                schema({
                    "instructions": {"type": "string", "description": "Everything the coding agent needs: goal, features, stack, constraints"},
                    "project": {"type": "string", "description": "Project folder name (new or existing)"},
                    "agent": {"type": "string", "enum": ["codex", "claude"], "description": "Default codex"},
                    "title": {"type": "string", "description": "Short title for the task list"},
                    "publish_github": {"type": "boolean", "description": "Also create a private GitHub repo and push"},
                }, ["instructions", "project"]),
                self.run_coding_agent, long_running=True, approval=True,
            ),
        ]
