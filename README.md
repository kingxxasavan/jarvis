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

Use a long password: whoever signs in can control your paired devices. Two-factor (an authenticator-app code) is optional in Settings.

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

1. Optional: **Turn on two-factor**.
2. **Import profile JSON**: pick `about_me_complete.json`.
3. **arkia.buzz**: link with your arkia email and password (used once, never stored), or Google. For Google,
   first add your Vercel domain under arkia's Firebase > Authentication > Settings > Authorized domains.
4. Optional: **Import watch history** from Google Takeout (YouTube and YouTube Music > history > JSON) so
   "play something I watched" covers videos watched outside Jarvis.
5. **Devices > Add device**: copy the pair command it shows (shown once), then follow section 4.

## 4. Laptop install (Windows 11, copy and paste)

Do this on the always-on laptop (and later the home PC, with a different device name). Open **Terminal**
(right-click Start > Terminal) and paste each block in order. Each block can be pasted whole.

**Before you start:** in JARVIS, open Settings > Devices > **Add device**, name it `Laptop`, and keep the
pair command it shows. It is shown only once.

### Step 1: install the tools

```powershell
winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
winget install -e --id Python.Python.3.12 --accept-package-agreements
winget install -e --id Google.Chrome --accept-package-agreements
winget install -e --id Cloudflare.cloudflared --accept-package-agreements
winget install -e --id GitHub.cli --accept-package-agreements
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements
```

**Close Terminal and open a new one** so it finds the new programs.

### Step 2: sign in to GitHub

```powershell
gh auth login
```

Answer: GitHub.com > HTTPS > Yes > Login with a web browser. Sign in as `kingxxasavan`.

### Step 3: download JARVIS and set up the agent

```powershell
cd ~
gh repo clone kingxxasavan/jarvis
cd ~\jarvis\agent
py main.py setup
```

### Step 4: pair this laptop

Paste the command from Settings > Devices, starting it with `py` instead of `python`:

```powershell
cd ~\jarvis\agent
py main.py pair PASTE-YOUR-CODE-HERE
```

### Step 5: Claude Code from the Claude desktop app (so JARVIS can build projects)

No API key needed: it runs on your Claude account. Install the Claude desktop app:

```powershell
winget install -e --id Anthropic.Claude --accept-package-agreements
```

Open **Claude** from the Start menu, sign in, and open its **Code** tab once (that downloads the Claude Code
engine JARVIS uses). Then sign that engine in once; a browser window opens for your Claude account:

```powershell
$claude = (Get-ChildItem "$env:APPDATA\Claude\claude-code\*\*\claude.exe" | Sort-Object LastWriteTime -Descending | Select-Object -First 1).FullName
& $claude auth login
```

Check it worked (`"loggedIn": true`):

```powershell
& $claude auth status
```

The desktop app's own sign-in does not carry over to this, so the step above is needed once. It stays signed in
when the app updates. JARVIS finds the newest copy by itself.

Optional, Codex (uses your ChatGPT account, also no API key):

```powershell
npm install -g @openai/codex
codex.cmd login
```

### Step 6: keep it awake 24/7

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

Never sleeps on the charger, and closing the lid does nothing. Keep it plugged in.

### Step 7: check everything

```powershell
cd ~\jarvis\agent
py main.py doctor
```

You want `connection OK`, and a path (not "not installed") for chrome, cloudflared and claude. Codex only if you installed it.

### Step 8: start with Windows, and start now

```powershell
cd ~\jarvis\agent
py main.py autostart on
py main.py
```

Within about 20 seconds it prints `JARVIS agent online as 'Laptop'` and `apps are reachable at https://...`.
Leave this window open while you test from your phone or Chromebook:

- Chat: "Open Spotify on my laptop".
- Apps tab: the laptop's Chrome appears. Click into the page to type; the speaker icon turns sound on. Sign in to
  Spotify and Google there once and they stay signed in.
- Close the lid and check the Apps picture still moves. If it freezes, leave the lid slightly open.

When it works, close the window and run JARVIS hidden in the background:

```powershell
cd ~\jarvis\agent
Start-Process .venv\Scripts\pythonw.exe -ArgumentList "main.py","run" -WorkingDirectory (Get-Location)
```

From now on it also starts by itself whenever you sign in to Windows. Logs: `~\jarvis\agent\data\agent.log`.

### Optional: VS Code from anywhere

```powershell
winget install -e --id Microsoft.VisualStudioCode --accept-package-agreements
```

Open a new Terminal:

```powershell
code tunnel service install
```

Sign in with GitHub and note the machine name it prints. Then add it to the agent settings (replace the name):

```powershell
cd ~\jarvis\agent
Add-Content .env "VSCODE_TUNNEL=PASTE-MACHINE-NAME-HERE"
```

Restart the agent (Step 9) and the VS Code button in Apps opens it.

### Step 9: update JARVIS later

```powershell
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe'" | Where-Object CommandLine -like '*main.py*run*' | ForEach-Object { Stop-Process -Id $_.ProcessId }
cd ~\jarvis
git pull
cd agent
py main.py setup
Start-Process .venv\Scripts\pythonw.exe -ArgumentList "main.py","run" -WorkingDirectory (Get-Location)
```

### If something is wrong

| You see | Fix |
| --- | --- |
| `connection FAILED: ... removed or its token is wrong` | Add the device again in Settings and redo Step 4. |
| `cloudflared` or `chrome` not installed | Redo its line from Step 1, then open a new Terminal. |
| `running scripts is disabled` | Use `codex.cmd` exactly as written above. |
| No `claude-code` folder found in Step 5 | Open the Claude app's Code tab once, wait for it to load, then rerun Step 5. |
| A build fails with a sign-in error | Rerun the two lines of Step 5 (`auth login`). |
| Apps tab says no device is streaming | Check the agent window shows `apps are reachable at https://...`. |
| Nothing works after a Windows Update restart | The agent starts when you sign in to Windows. Sign in once. |

### Other settings (`~\jarvis\agent\.env`)

- `JARVIS_WORKSPACE`: where projects are created (default `~\JarvisProjects`).
- `JARVIS_DOWNLOADS`: where downloads go (default `~\Downloads\JARVIS`).
- `JARVIS_STREAM=off`: turn app streaming off on this device.
- Fixed apps address on your own domain: create a Cloudflare tunnel pointing at `http://localhost:8788`, then set
  `CLOUDFLARE_TUNNEL_TOKEN=` and `STREAM_PUBLIC_URL=https://apps.yourdomain`.

When several devices are online, JARVIS uses the one you name ("on my home PC") or the most recently active.
On Linux the same steps apply with `python3`, and `autostart on` installs a systemd user service.

## Security model

- One owner. The site rejects every account except `OWNER_EMAIL`; sign-ups are off in Supabase; every table
  has row-level security. Two-factor is optional; once enabled it is enforced at every sign-in.
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
