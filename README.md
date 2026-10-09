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
| Projects | "Build me a ... on my laptop": Claude Code (or Codex) runs on the device straight away, the log streams into Tasks, the result is committed to git, optionally pushed to a private GitHub repo. If Claude Code is not reachable, Jarvis writes the files itself. |
| New abilities | When Jarvis has no tool for something, it says so in chat and has Claude Code write one (or writes it itself when Claude Code is unavailable). The code is import-checked, saved to the database (Tasks > Tools Jarvis built, and a tile in Apps) and switched on when it loads cleanly. Saved tools can be installed on another device from the Tasks page. |
| Apps (streamed) | A home screen of icons: every app installed on the laptop (with its real icon), web apps (Spotify, YouTube, Gmail, Classroom, Claude...) and JARVIS's own sections. Each opens in a window with a Home button. Web apps run in the laptop's real Chrome with its logins and sound (sites the school network blocks work); laptop apps run on the laptop's screen (**Desktop**), with mouse and keyboard. Downloads appear under the icons and can save to the device you are on automatically; when a website on the laptop asks for a file, you pick it from the device you are on. Runs through a Cloudflare Tunnel; each connection needs a short-lived pass from your signed-in JARVIS. |
| Files | The **Files** tab is a file manager for the laptop: browse Desktop, Documents, Downloads and more, view files in the page, download them to the device you are on, upload into any folder, or open them on the laptop. **Cloud files**: everything the laptop downloads (in the streamed Chrome or via Jarvis) is also copied to your Supabase storage, up to 50 MB a file, so it can be downloaded on any computer even when the laptop is off. Upload from any browser too, and send a cloud file back to the laptop. |
| Code | The **Code** tab talks to Claude Code on the laptop directly: pick a folder (JARVIS's own code, a project, or any folder), type what to build or fix, watch the live log, and follow up in the same Claude Code conversation. Optionally commit and push. **Restart agent** and **Update from GitHub** load changes on the laptop without being there. |
| Reading files | "What's in the spreadsheet I downloaded?": Jarvis reads xlsx, csv, Word, PowerPoint, PDF and text files on the laptop and answers in chat. |
| Device control | Open apps, open pages, media/volume keys, system status, project files. Each action reports what it actually observed. |
| Web | Live search and page reading through Ollama's web search API (same Ollama key). |

## Install (from scratch)

You need three things: a Supabase project (database and login), the website on Vercel, and the laptop agent.
If Supabase and Vercel are already set up, skip to step 3.

### 1. Supabase (database and login)

1. Create a project at supabase.com (free tier is enough).
2. SQL Editor > paste all of `supabase/schema.sql` > Run. It is safe to run again after every update.
3. Authentication > Sign In / Providers > Email: keep Email on, **turn off "Allow new users to sign up"**.
4. Authentication > Users > Add user: your email and a strong password (tick "Auto confirm").
5. Project Settings > API: note the Project URL and the **publishable** key.

Use a long password: whoever signs in can control your paired devices. Two-factor (an authenticator-app code) is
optional in Settings.

### 2. Vercel (the website)

1. Keep this repo on GitHub (private). Vercel deploys from it, and the laptop installer downloads it.
2. vercel.com > Add New Project > import it > **Root Directory: `web`**.
3. Add the environment variables from `web/.env.example`:
   - `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`
   - `OWNER_EMAIL` (the user from step 1.4), `OWNER_NAME`, `OWNER_TIMEZONE`
   - `NVIDIA_API_KEY` (build.nvidia.com), `OLLAMA_API_KEY` (ollama.com/settings/keys)
   - `APP_ENCRYPTION_KEY`: run `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`
   - the four `NEXT_PUBLIC_ARKIA_*` values exactly as in the example
4. Deploy, open the site, sign in.

Model ids change often. Before changing `NVIDIA_MODEL`, check https://integrate.api.nvidia.com/v1/models.

### 3. The laptop: one install

1. In JARVIS: **Settings > Devices**, type `Laptop`, press **Add device**, and copy the code it shows (shown once).
2. On the laptop, get this repo: on github.com open the repo > **Code > Download ZIP**, and extract it anywhere
   (or `git clone` it if Git is already installed).
3. Double-click **`install.cmd`** in the extracted folder. Answer what it asks:
   - a browser opens to sign in to **GitHub** (it downloads JARVIS to `C:\Users\<you>\jarvis` so updates work);
   - paste the **pair code** from step 1;
   - a browser opens to sign in to **Claude** (Claude Code uses your Claude account, no API key).

It installs Git, Python, Chrome, cloudflared, GitHub CLI, Node.js, the Claude desktop app, Claude Code, Codex and
VS Code, sets up the agent, keeps the laptop awake on the charger with the lid closed and no password on wake,
and starts JARVIS hidden with Windows. The ZIP folder can be deleted afterwards.

At the end it prints a check: you want `connection OK` and a path (not "not installed") for chrome, cloudflared
and claude. Within about 20 seconds the laptop shows as online in JARVIS.

Then test from your phone or Chromebook: "open Spotify on my laptop", or **Apps > Spotify**. Sign in to Spotify
and Google once in the streamed Chrome and they stay signed in.

### 4. First run in the browser

Settings, in this order (all optional):

1. **Turn on two-factor**.
2. **Import profile JSON**: pick `about_me_complete.json`.
3. **arkia.buzz**: link with your arkia email and password (used once, never stored), or Google. For Google, first
   add your Vercel domain under arkia's Firebase > Authentication > Settings > Authorized domains.
4. **Import watch history** from Google Takeout (YouTube and YouTube Music > history > JSON).

## Updating

- **Website:** Vercel redeploys on every push to `main`. If an update says so, run `supabase/schema.sql` again.
- **Laptop, from anywhere:** **Code > Update from GitHub** pulls the new code onto the laptop and restarts the agent.
- **Laptop, in person:** run `install.cmd` again (in `C:\Users\<you>\jarvis`). It updates everything in place and
  keeps the pairing.

## Laptop notes

- Apps > **Desktop** needs Windows signed in and unlocked: the lock screen cannot be captured or controlled. The
  installer turns off the password on wake; also set Settings > Accounts > Sign-in options > "If you've been away,
  when should Windows require you to sign in again?" to **Never**, and leave the screen saver off.
- Close the lid and check the Apps picture still moves. If it freezes, leave the lid slightly open.
- VS Code from anywhere: on the laptop run `code tunnel service install`, sign in with GitHub, then add
  `VSCODE_TUNNEL=<machine name>` to `C:\Users\<you>\jarvis\agent\.env` and run `install.cmd` again.
- Logs: `C:\Users\<you>\jarvis\agent\data\agent.log`. A health check: in that `agent` folder run `py main.py doctor`.

### If something is wrong

| You see | Fix |
| --- | --- |
| install.cmd says winget is missing | Microsoft Store > search "App Installer" > Update. Run install.cmd again. |
| `connection FAILED: ... removed or its token is wrong` | Add the device again in Settings > Devices, delete `agent\.env`, run install.cmd again. |
| doctor says claude NOT signed in, or builds fail with a sign-in error | In the `agent` folder run `py main.py claude-login`. Until then Jarvis writes code itself. |
| Apps says no device is streaming | Check `agent.log` for `apps are reachable at https://...`; run install.cmd again if cloudflared is missing. |
| Desktop is black or says the screen cannot be captured | Sign in to Windows on the laptop (it is locked). |
| The site shows "Something on this page crashed" | The message is on screen and in Vercel > Logs (search `client-error`). |
| Nothing works after a Windows Update restart | The agent starts when you sign in to Windows. Sign in once. |

### Settings (`C:\Users\<you>\jarvis\agent\.env`)

- `JARVIS_WORKSPACE`: where projects are created (default `~\JarvisProjects`).
- `JARVIS_DOWNLOADS`: where downloads go (default `~\Downloads\JARVIS`).
- `JARVIS_ASK_FIRST=on`: put an approval card in front of coding runs again (off by default: JARVIS acts without asking).
- `JARVIS_STREAM=off`: turn app streaming off on this device.
- `JARVIS_CLOUD=off`: do not copy downloads to cloud files. `JARVIS_CLOUD_MAX_MB=50`: the largest file copied
  (Supabase's free plan allows 50 MB per file).
- `JARVIS_AUDIO_DEVICE`: which output to stream sound from (default: the speakers). To hear streamed sound only on
  the phone or Chromebook and keep the laptop silent: install the free VB-CABLE (vb-audio.com/Cable), then Windows
  Settings > System > Sound > Volume mixer > set Chrome's output to "CABLE Input", and add
  `JARVIS_AUDIO_DEVICE=CABLE Input` to `.env`. Tap the speaker icon in Apps to turn sound on (on an iPhone, the page
  also plays with the silent switch on).
- Fixed apps address on your own domain: create a Cloudflare tunnel pointing at `http://localhost:8788`, then set
  `CLOUDFLARE_TUNNEL_TOKEN=` and `STREAM_PUBLIC_URL=https://apps.yourdomain`.

When several devices are online, JARVIS uses the one you name ("on my home PC") or the most recently active.
On Linux the same steps apply with `python3`, and `autostart on` installs a systemd user service.

## Security model

- One owner. The site rejects every account except `OWNER_EMAIL`; sign-ups are off in Supabase; every table
  has row-level security. Two-factor is optional; once enabled it is enforced at every sign-in.
- Devices never accept connections. The agent polls Supabase with a device token; the database functions it may
  call check the token's hash and only touch that device's jobs. It holds no service key and cannot read any table.
  Cloud uploads go only into one-time slots the database opened for that device.
- JARVIS acts without approval cards by default (you asked for this): coding runs, file writes and new tools run
  straight away, and new tools switch on when they load cleanly. Set `JARVIS_ASK_FIRST=on` to bring the cards back.
  File tools refuse system folders (Windows, Program Files, AppData) and secret files (.env, keys, .ssh). Coding
  runs are committed to git, so changes can be reverted.
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
install.cmd, install.ps1   one-click laptop install and update (Windows)
supabase/schema.sql        tables, row-level security, memory search, device RPCs, cloud files, saved tools
web/src/proxy.ts           session refresh + owner/2FA gate for every request
web/src/lib/ai/            providers (NIM -> Ollama), brain (tool loop), persona, stream events
web/src/lib/tools/         web, youtube, memory, arkia, device tools (pc_* from each device's manifest), build_tool
web/src/lib/memory/        store + hybrid recall, adaptive learning, profile import
web/src/lib/arkia/         Firebase REST client, calendar recurrence (mirrors arkia's own rules)
web/src/lib/youtube/       search / channel RSS / embeddability, watch history, Takeout parser
web/src/app/api/           chat (streaming), pulse, memory, tasks, devices, arkia, youtube, conversations
web/src/components/        HUD: orb, panels, transcript, composer, player, views (chat, apps, files, code, tasks...)
agent/main.py              setup | pair | run | doctor | autostart | test
agent/jarvis_agent/        api (RPC), runner (job loop), registry (tools + plugins), coding (Codex/Claude)
agent/jarvis_agent/tools/  system (apps, media, YouTube), files (folders, read_file), projects (coding runs, Code tab),
                           plugins (self-extension), apps (streamed browser, downloads)
agent/jarvis_agent/stream/ stream server: Chrome, desktop capture and input, sound, file manager routes, tunnel
agent/jarvis_agent/cloud.py copies downloads to cloud files
```
