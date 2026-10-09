"""Projects in the workspace folder, and building them with Codex or Claude Code."""

from __future__ import annotations

import re
import shutil
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any

from ..coding import available, run_agent
from ..config import JARVIS_REPO
from ..registry import Tool, ToolContext, schema
from . import files as fs

DENY = re.compile(r"(^|[\\/])(\.env[^\\/]*|\.git|node_modules|\.venv|id_rsa[^\\/]*|.*\.pem|.*\.key)$", re.I)

GUIDE = """You are building software for the owner of this computer, working fully on your own. Do not ask questions;
make sensible decisions and note them. Write complete, working, production-quality code
(no placeholders or TODO stubs), keep it modular and readable, and include a short README
with how to run it. If the project has a build or test command, run it and fix what fails.
Never print or commit secrets. When done, reply with a summary under 150 words: what you
built, where the main files are, and the exact command to run it.

Task:
"""

DIRECT = """You are working for the owner of this computer, who is typing to you remotely from the JARVIS website and
cannot answer questions mid-run. Do exactly what they ask in this folder, make sensible decisions, run the
project's own checks when there are any, and never print or commit secrets. Finish with a short plain summary
(under 120 words) of what you changed and anything they must do next.

Request:
"""

class Workspace:
    def __init__(self, root: Path, codex_bin: str = "", claude_bin: str = "", restart=None):
        self.restart = restart
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
            raise RuntimeError("Neither Claude Code nor Codex is installed on this device (rerun install.cmd to add Claude Code). "
                               "Fallback: write the files yourself with pc_write_file.")
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
            hint = " Fallback: write the files yourself with pc_write_file." if re.search(r"sign|log ?in|auth|not found|credit|limit", result.error, re.I) else ""
            raise RuntimeError(f"{agent} stopped: {result.error}" + (f" (work so far saved as commit {commit})" if commit else "") + hint)
        if args.get("publish_github"):
            out["repo_url"] = self._publish(project, ctx)
        return out

    def folder(self, raw: str) -> Path:
        """A folder for a direct Code session: "jarvis", a workspace project, or any path under home."""
        text = str(raw or "").strip()
        if not text:
            raise ValueError("Pick a folder.")
        if text.lower() in ("jarvis", "jarvis code", str(JARVIS_REPO).lower()):
            return JARVIS_REPO
        if "/" not in text and "\\" not in text:
            candidate = self.root / self.slug(text)
            if candidate.exists() or not fs.resolve(text).exists():
                return candidate
        return fs.resolve(text)

    def code_folders(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        self.root.mkdir(parents=True, exist_ok=True)
        projects = sorted((p for p in self.root.iterdir() if p.is_dir() and not p.name.startswith(".")),
                          key=lambda x: x.stat().st_mtime, reverse=True)
        tools = available(self.codex_bin, self.claude_bin)
        return {
            "folders": [{"label": "JARVIS (this app's code)", "path": str(JARVIS_REPO)}]
                       + [{"label": p.name, "path": str(p)} for p in projects[:60]],
            "agents": [a for a in ("claude", "codex") if tools.get(a)],
            "workspace": str(self.root),
        }

    def code_session(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        """Sir's own instructions to Claude Code (or Codex), typed on the Code tab."""
        prompt = str(args.get("instructions") or "").strip()
        if len(prompt) < 3:
            raise ValueError("Type what Claude Code should do.")
        folder = self.folder(str(args.get("folder") or ""))
        tools = available(self.codex_bin, self.claude_bin)
        wanted = str(args.get("agent") or "claude").lower()
        agent = next((a for a in [wanted, "claude", "codex"] if tools.get(a)), None)
        if not agent:
            raise RuntimeError("Claude Code is not set up on this device. Run `py main.py claude-login` there once.")
        folder.mkdir(parents=True, exist_ok=True)
        resume = str(args.get("resume") or "") if agent == wanted else ""
        ctx.log("log", f"{agent} in {folder}" + (" (continuing the conversation)" if resume else ""))
        before = self._git(folder, "rev-parse", "HEAD").stdout.strip() if (folder / ".git").exists() else ""
        result = run_agent(agent, tools[agent] or "", (DIRECT + prompt) if not resume else prompt, folder, ctx.log,
                           ctx.cancelled, resume=resume)
        out: dict[str, Any] = {"folder": str(folder), "agent": agent, "summary": result.summary, "session_id": result.session_id}
        if (folder / ".git").exists():
            changed = self._git(folder, "status", "--porcelain").stdout.splitlines()
            out["files_changed"] = [line[3:] for line in changed][:300]
            if args.get("commit") and changed:
                sha, files = self._commit(folder, prompt[:60])
                out["commit"], out["files_changed"] = sha, files
            if args.get("push") and (out.get("commit") or self._git(folder, "rev-parse", "HEAD").stdout.strip() != before):
                res = self._git(folder, "push")
                ctx.log("log" if res.returncode == 0 else "error", (res.stderr or res.stdout).strip()[:500] or "Pushed.")
                out["pushed"] = res.returncode == 0
        if not result.ok:
            raise RuntimeError(f"{agent} stopped: {result.error}")
        return out

    def restart_agent(self, args: dict[str, Any], ctx: ToolContext) -> dict[str, Any]:
        """Optionally pull the latest JARVIS code, then restart this agent so changes load."""
        notes = []
        if args.get("update"):
            res = self._git(JARVIS_REPO, "pull", "--ff-only")
            notes.append((res.stdout or res.stderr).strip()[:500])
            if res.returncode != 0:
                raise RuntimeError(f"git pull failed: {notes[-1]}")
            import sys

            req = JARVIS_REPO / "agent" / "requirements.txt"
            pip = subprocess.run([sys.executable, "-m", "pip", "install", "--quiet", "-r", str(req)],
                                 capture_output=True, text=True, timeout=600)
            notes.append("Requirements installed." if pip.returncode == 0 else f"pip: {pip.stderr.strip()[-400:]}")
        if not self.restart:
            raise RuntimeError("This agent cannot restart itself here.")
        self.restart()
        return {"restarting": True, "notes": notes, "note": "The agent restarts in a few seconds."}

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
            Tool("code_folders", "Folders the Code tab can work in.", schema(), self.code_folders, hidden=True),
            Tool("code_session", "Sir's own instructions to Claude Code from the Code tab.",
                 schema({"instructions": {"type": "string"}, "folder": {"type": "string"}, "agent": {"type": "string"},
                         "resume": {"type": "string"}, "commit": {"type": "boolean"}, "push": {"type": "boolean"}},
                        ["instructions", "folder"]),
                 self.code_session, long_running=True, hidden=True),
            Tool("restart_agent", "Restart the agent, optionally after pulling the latest JARVIS code.",
                 schema({"update": {"type": "boolean"}}), self.restart_agent, hidden=True, timeout=60),
        ]
