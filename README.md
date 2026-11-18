# Anexis, server edition

Anexis as a plain server program: a personal AI assistant that lives on a Linux
server and talks to you in a terminal. Same brain as the Anexis PC app (models,
SQL memory that learns you, tools, coding), with everything that needs a desktop
taken out. No screen, no deck, no voice, no token to set up.

```
anexis · nvidia llama-3.3-70b-instruct · 214 memories · 259 tools · ask
due soon: Chem 101: Lab 3 writeup (due 2026-11-20 23:59)
/help for commands · ctrl+c stops a reply · /quit leaves

> whats due this week and can you make me a study plan
  [tool] list_items type=assignment
  Two things. The chem lab is due Thursday and the essay outline Friday.
  Here is a plan that fits around both: ...
  3.8s · list_items · 4 memories
```

## Install

On the server, in this folder:

```bash
bash install.sh
```

It installs uv (which brings its own Python), the `anexis` command, and Node for
the npm tool servers if the server has none. Then it runs the checkup. It asks
nothing and needs no keys. Run it again any time to update.

It also sets up the model, on the server itself with Ollama: no key, nothing to
sign up for. It installs Ollama if it is missing, then runs `anexis ollama`,
which:

1. picks a model that fits the server's memory: `gpt-oss:20b`, a mixture of
   experts (MoE) model, with 16 GB or more, else `qwen3:4b`,
2. pulls it and `nomic-embed-text` (for meaning search in memory),
3. builds a local model called `anexis` from it with a 16k token window.
   Ollama's default window is about 4096 tokens and its OpenAI style API
   ignores a bigger one asked for per request, so without this Ollama
   silently cuts off Anexis's instructions and tools,
4. points `~/.anexis/anexis.toml` at it and restarts Anexis.

Run `anexis ollama` again any time, or name a model: `anexis ollama qwen3:30b-a3b`.
For a hosted model instead, run `bash install.sh --no-ollama`, put
`NVIDIA_API_KEY=...` in `~/.anexis/.env`, and pick its model with `/model`.

## Use it

```bash
ssh you@your-server
anexis            # or: jarvis
```

The first `anexis` starts the server in the background. It keeps running after
you close the terminal, so the next chat opens right away and tools stay warm.
To have it start with the server, see the top of `anexis.service`.

| Command | What it does |
|---|---|
| `anexis` | chat |
| `anexis ask "..."` | one question, one answer, for scripts and cron |
| `anexis doctor` | checks every part and says how to fix what is missing |
| `anexis tools` | every tool and tool server |
| `anexis watch` | what Anexis is doing, live, from a second terminal |
| `anexis ollama [model]` | use Ollama on the server, set up in one go |
| `anexis status` / `start` / `stop` / `restart` | the background server |

In the chat: `/help` lists everything. The main ones are `/new`, `/chats`,
`/open <n>`, `/model`, `/memory [words]`, `/remember`, `/pin` (something always
true about you), `/forget <n>`, `/why`, `/code <what to build>`, `/tools`,
`/doctor`.

### Picking the model

`/model` lists the models each provider really has right now, with the one in
use marked. `/model llama` searches the list, `/model 3` switches to number 3.
A model is tried with a one word test before the switch, so a broken pick
changes nothing. The switch works at once and is saved in `anexis.toml` (the
old file is kept as `anexis.toml.bak`). Add a job to switch just that one:
`/model 3 coder` (jobs: chat, tools, coder, small, embed).

Providers retire models. When the one Anexis is set to use is gone, Anexis
swaps it for the closest model that provider still has when it starts, saves
that, and says so at the top of the chat.

When Anexis wants to do something risky (run a command, end a program, write
outside its workspace) it asks first, right in the chat: `allow? y/N`. To let
everything run without asking, set `control = "full"` in `~/.anexis/anexis.toml`.

### Reaching it from a browser (Shellngn)

The server only listens on the server itself (127.0.0.1). That is why there is
no token: nothing outside the machine can talk to it. You reach it by SSH, so
any SSH client works, including a browser one like Shellngn on a Chromebook.

1. In Shellngn, add the server: its address, port 22, your user, and your SSH
   key (or password).
2. Connect, then type `anexis`.

Good to know:

* Only the server's SSH port has to be reachable. Never open port 8765.
* Shellngn reaches your server from the internet, so SSH is open to the
  internet too. Log in with a key and turn password login off in
  `/etc/ssh/sshd_config` (`PasswordAuthentication no`) once the key works.
* Closing the tab ends the chat, not Anexis. A reply that was still being
  written stops. Type `anexis` again, then `/chats` and `/open 1` to carry on.
* Leave with `/quit`. In a browser Ctrl+D may be taken by the browser itself.
  Ctrl+C still stops a reply.

## Tools

**Built in, nothing needed:**

| Area | Tools |
|---|---|
| Everyday | `time_now`, `calculate`, `remember`, `recall`, `find_tools` |
| Lists | `add_item`, `list_items`, `complete_item`, `delete_item` (notes, todos, assignments, reminders with due dates) |
| Server | `read_file`, `write_file`, `list_dir`, `search_files`, `run_shell`, `run_python`, `server_status`, `list_processes`, `end_process` |
| Web | `web_search`, `web_fetch`, `github_search_repos`, `github_read_file` |
| Code | `code_task`: Claude Code does it if it is installed and signed in on the server, else Anexis's own coder does |

**Tool servers** (`tools.yaml`, downloaded on first start, no keys): files, git,
step by step thinking, time zones, calculator, page fetch, DuckDuckGo, library
docs (Context7), DeepWiki, Wikipedia, arXiv, YouTube transcripts, a headless
browser (Playwright), Word, Excel, charts. That is around 250 tools in total.
Anexis offers the model only the dozen that fit each message, and the model can
ask for more with `find_tools`.

**Only when you add their key** to `~/.anexis/.env` (see `.env.example`):
Canvas (`CANVAS_URL`, `CANVAS_TOKEN`), GitHub code search and the GitHub tool
server (`GITHUB_TOKEN`), Notion, Brave, Tavily, Firecrawl, Exa. Without the key
they are simply not there, so they can never throw an error.

## How it is built

```
  anexis (cli/chat.py)  ──HTTP on 127.0.0.1──>  server.py
                                                    │
                                                  app.py  builds and holds:
           ┌───────────────┬──────────────┬─────────┴──────┬──────────────┐
       config.py        llm.py        memory/          tools/          agent.py
       settings,     providers +    store.py SQLite   built ins,      the chat loop:
       never crashes  failover      learn.py learns   mcp.py servers  recall, ask the
                                    style.py how you  code.py coding  model, run tools,
                                    talk              registry picks  repeat, learn
```

| File | Job |
|---|---|
| `anexis/config.py` | Settings from `anexis.toml` and `.env`. A bad value is noted and the default used, it never stops Anexis. |
| `anexis/llm.py` | One client for any OpenAI style API (Ollama, Nvidia, others), and the router that moves to the next provider when one is down. |
| `anexis/memory/store.py` | One SQLite file: chats, memories (word search plus meaning search), lists, tool stats. |
| `anexis/memory/learn.py` | After each reply, a small model proposes what to remember. Hourly upkeep: summaries, merging duplicates, fading what is never used. |
| `anexis/memory/style.py` | Learns how you write and think, so answers fit you. |
| `anexis/tools/` | `core`, `system`, `web`, `canvas`, `code` are the built ins. `mcp.py` runs the tool servers. `registry.py` picks which tools the model sees. `permissions.py` decides what asks first. |
| `anexis/agent.py` | The chat loop. |
| `anexis/app.py` | Wires it all together and runs the background jobs. |
| `anexis/server.py` | The local HTTP API the chat uses. |
| `anexis/cli/` | The `anexis` command and the chat screen. |
| `anexis/doctor.py` | The checkup. |

Files on the server: `~/.anexis/` holds settings, keys, the database, logs and
the downloaded tool servers. `~/anexis/workspace/` is where Anexis makes files
and code projects.

## Develop

```bash
uv sync
uv run pytest
uv run ruff check anexis tests
```
