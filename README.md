# JARVIS

A private AI assistant you can open from any browser (school Chromebook, phone, laptop) that can also act on
your own computers. It is two parts:

```
 Browser (anywhere) ──HTTPS──> web/  Next.js on Vercel ──> NVIDIA NIM (primary) / Ollama Cloud (fallback)
                                 │   login + 2FA, chat, tools, memory, arkia.buzz, YouTube
                                 ▼
                            Supabase (Postgres): conversations, memory, jobs, devices
                                 ▲
                                 │ polls for work (outbound only, nothing exposed)
 Laptop / PC ── agent/ (Python) ─┘   apps, YouTube, media keys, Codex / Claude Code, plugins
```

The website works on its own. When a device agent is online, Jarvis can also use that computer.

## What it can do

| Area | How |
| --- | --- |
| Chat and voice | NIM `nemotron-3-super-120b-a12b`, automatic failover to Ollama Cloud `gpt-oss:120b`. Mic and speech use the browser (Chrome/Edge/ChromeOS), no extra service. |
| YouTube | "Play the latest MrBeast video", "play that MKBHD iPhone review", "play what I watched yesterday". Keyless search, a channel's newest uploads via RSS, and a check that the video allows embedding before it plays, so you never land on "Video unavailable". Plays in a floating player, or on a device. |
| Adaptive memory | After every reply a background pass adds, updates or deletes long-term facts. Recall blends meaning (NIM embeddings) with keywords, importance and recent use. Browse, edit and delete everything on the Memory page. |
| Your profile | Import `about_me_complete.json` once. Unconfirmed or old details are marked so Jarvis checks them with you instead of assuming. |
| arkia.buzz | Calendar, tasks and reminders (read, add, tick off), friends' messages. Unread messages and due reminders pop up and are spoken while Jarvis is open. |
| Projects | "Build me a ... on my laptop": Codex or Claude Code runs on the device, the log streams into Tasks, the result is committed to git, optionally pushed to a private GitHub repo. Needs your approval. |
| New abilities | "Build yourself a tool that ...": Codex/Claude Code writes a plugin, it is import-checked, you read the code on the Tasks page and press Enable. Then every Jarvis surface can use it, with no redeploy. |
| Apps (streamed) | The laptop's real Chrome, with its own logins, streamed into the **Apps** tab with sound: browse, use the Spotify web player, sites the school network blocks. Downloads land on the laptop and can be saved to whatever device you are on. VS Code opens through Microsoft's own VS Code tunnel. Runs through a Cloudflare Tunnel; each connection needs a short-lived pass from your signed-in JARVIS. |
| Device control | Open apps, open pages, media/volume keys, system status, project files. Each action reports what it actually observed. |
| Web | Live search and page reading through Ollama's web search API (same Ollama key). |

## 1. Supabase (database and login)

1. Create a project at supabase.com (free tier is enough).
2. SQL Editor > paste all of `supabase/schema.sql` > Run. It is safe to run again after updates.
3. Authentication > Sign In / Providers > Email: keep Email on, **turn off "Allow new users to sign up"**.
4. Authentication > Users > Add user: your email and a strong password (tick "Auto confirm").
5. Project Settings > API: note the Project URL and the **publishable** key.

Two-factor (TOTP) is built into Supabase Auth; you turn it on from JARVIS Settings after the first sign-in.

## 2. Vercel (the website)

1. Push this repo to GitHub (private).
2. vercel.com > Add New Project > import it > **Root Directory: `web`**.
3. Add the environment variables from `web/.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `OWNER_EMAIL` (the user from step 1.4), `OWNER_NAME`, `OWNER_TIMEZONE`
   - `NVIDIA_API_KEY` (build.nvidia.com), `OLLAMA_API_KEY` (ollama.com/settings/keys)
   - `APP_ENCRYPTION_KEY`: run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - the four `NEXT_PUBLIC_ARKIA_*` values exactly as in the example
4. Deploy, open the site, sign in.

Model ids change often. Before changing `NVIDIA_MODEL`, check https://integrate.api.nvidia.com/v1/models.

## 3. First run in the browser

Settings, in this order:

1. **Turn on two-factor.** Device control is refused without it.
2. **Import profile JSON**: pick `about_me_complete.json`.
3. **arkia.buzz**: link with your arkia email and password (used once, never stored), or Google. For Google,
   first add your Vercel domain under arkia's Firebase > Authentication > Settings > Authorized domains.
4. Optional: **Import watch history** from Google Takeout (YouTube and YouTube Music > history > JSON) so
   "play something I watched" covers videos watched outside Jarvis.
5. **Devices > Add device**: copy the `python main.py pair ...` command it shows (shown once).

## 4. The laptop (24/7) and the home PC

Needs Python 3.10+ and git. For building projects, also Node.js plus Codex and/or Claude Code, signed in with
your own accounts:

```bash
npm install -g @openai/codex
```

```bash
codex login
```

```bash
npm install -g @anthropic-ai/claude-code
```

```bash
claude auth login
```

Then, in this repo's `agent` folder:

```bash
python main.py setup
```

```bash
python main.py pair <code from Settings>
```

```bash
python main.py autostart on
```

```bash
python main.py
```

**Apps streaming** needs Chrome and Cloudflare's tunnel program on the laptop:

```bash
winget install --id Cloudflare.cloudflared
```

That gives a free tunnel whose address changes on each restart; the agent reports every new one to JARVIS
automatically. For a fixed address on your own domain, create a tunnel in the Cloudflare dashboard pointing at
`http://localhost:8788` and put `CLOUDFLARE_TUNNEL_TOKEN=` and `STREAM_PUBLIC_URL=https://apps.yourdomain` in
`agent/.env`. For VS Code, run `code tunnel service install` once on the laptop and set `VSCODE_TUNNEL=<the
machine name it shows>` in `agent/.env`. Set `JARVIS_STREAM=off` to disable streaming on a device.

Step-by-step for a fresh Windows laptop: [docs/thinkpad-setup.md](docs/thinkpad-setup.md).

`python main.py doctor` checks the connection and which coding tools it found. Projects are created in
`~/JarvisProjects` (set `JARVIS_WORKSPACE` in `agent/.env` to change it). Logs are in `agent/data/agent.log`.

For an always-on laptop: Windows Settings > System > Power > Screen and sleep: "Never" when plugged in, and
Control Panel > Power Options > "Choose what closing the lid does" > Do nothing. On Linux, `autostart on`
installs a systemd user service; run `sudo loginctl enable-linger $USER` so it runs without a login.

Pair the home PC the same way with a different name. When several devices are online, Jarvis picks the one you
name ("on my home PC") or the most recently active one.

## Security model

- One owner. The site rejects every account except `OWNER_EMAIL`; sign-ups are off in Supabase; every table
  has row-level security; 2FA is enforced at sign-in once enabled and is required to pair devices and approve tasks.
- Devices never accept connections. The agent polls Supabase with a device token; the database functions it may
  call check the token's hash and only touch that device's jobs. It holds no service key and cannot read any table.
- Code changes on a device (coding runs, new plugins) wait for your approval card. Plugins run only after you read
  them and press Enable. Coding runs are committed to git, so any change can be reverted.
- API keys live only in Vercel's server environment. The arkia token is AES-256-GCM encrypted at rest.
- Web pages, friends' messages and tool output are passed to the model as data, never as instructions.

## Development

```bash
cd web && npm install && npm run dev
```

Copy `web/.env.example` to `web/.env.local` first. Tests:

```bash
cd web && npm test
```

```bash
cd agent && python main.py test
```

## Layout

```
supabase/schema.sql        tables, row-level security, memory search, device RPCs
web/src/proxy.ts           session refresh + owner/2FA gate for every request
web/src/lib/ai/            providers (NIM -> Ollama), brain (tool loop), persona, stream events
web/src/lib/tools/         web, youtube, memory, arkia, device tools (pc_* from each device's manifest)
web/src/lib/memory/        store + hybrid recall, adaptive learning, profile import
web/src/lib/arkia/         Firebase REST client, calendar recurrence (mirrors arkia's own rules)
web/src/lib/youtube/       search / channel RSS / embeddability, watch history, Takeout parser
web/src/app/api/           chat (streaming), pulse, memory, tasks, devices, arkia, youtube, conversations
web/src/components/        HUD: orb, panels, transcript, composer, player, views
agent/main.py              setup | pair | run | doctor | autostart | test
agent/jarvis_agent/        api (RPC), runner (job loop), registry (tools + plugins), coding (Codex/Claude)
agent/jarvis_agent/tools/  system (apps, media, YouTube), projects (coding runs), plugins (self-extension)
```
