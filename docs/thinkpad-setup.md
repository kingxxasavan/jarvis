# ThinkPad T450 setup (Windows 11, always-on JARVIS laptop)

Every command runs in **Terminal** (right-click Start > Terminal). Copy one block at a time.

## Before you start (on the website)

1. Supabase SQL Editor: run the "Apps" migration (the `alter table public.devices ...` and
   `agent_stream` block from `supabase/schema.sql`) if you have not already.
2. JARVIS > Settings > Devices > **Add device**, name it `Laptop`, and keep the
   `python main.py pair ...` command it shows open (it is shown once).

## 1. Install the tools

```
winget install -e --id Git.Git --accept-package-agreements --accept-source-agreements
winget install -e --id Python.Python.3.12 --accept-package-agreements
winget install -e --id Google.Chrome --accept-package-agreements
winget install -e --id Cloudflare.cloudflared --accept-package-agreements
winget install -e --id GitHub.cli --accept-package-agreements
winget install -e --id OpenJS.NodeJS.LTS --accept-package-agreements
```

Close Terminal and open a new one so the new commands are found.

## 2. Get the code

```
gh auth login
```

Choose GitHub.com > HTTPS > Yes > Login with a web browser, and sign in as kingxxasavan.

```
cd ~
gh repo clone kingxxasavan/jarvis
cd jarvis\agent
```

## 3. Set up and pair the agent

```
py main.py setup
```

Paste the pair command from the website, but start it with `py` instead of `python`:

```
py main.py pair <the long code>
```

```
py main.py doctor
```

Expected: `connection OK`, a path for `chrome` and `cloudflared`. Codex and Claude show "not installed"
until step 4.

## 4. Coding agents (for "build me a project")

```
npm install -g @anthropic-ai/claude-code @openai/codex
```

```
claude.cmd auth login
codex.cmd login
```

(`.cmd` avoids PowerShell's "running scripts is disabled" error.) Sign in with your Claude and ChatGPT
accounts. Run `py main.py doctor` again: both should now show a path.

## 5. VS Code (optional)

```
winget install -e --id Microsoft.VisualStudioCode
```

Open a new Terminal, then:

```
code tunnel service install
```

Sign in with GitHub when asked and note the machine name it prints. Add it to the agent settings:

```
notepad .env
```

Add a line `VSCODE_TUNNEL=<that name>`, save, close.

## 6. Keep it running 24/7

```
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setactive SCHEME_CURRENT
```

That is: never sleep or hibernate on charger, and closing the lid does nothing. Keep it plugged in.

Start the agent with Windows, then run it now:

```
py main.py autostart on
py main.py
```

Leave this window open for the first test. You should see `JARVIS agent online as 'Laptop'` and
`apps are reachable at https://....trycloudflare.com` within about 20 seconds.

## 7. Test from another device

- Chat: "What can my laptop do?" and "Open Spotify on my laptop".
- Apps tab: the laptop's Chrome appears. Click into the page to type. Speaker icon = sound.
  Sign in to Spotify and Google there once; they stay signed in.
- Close the lid and check the Apps picture still updates. If it freezes, keep the lid slightly open.

When everything works, close the Terminal window and either restart the laptop or start the agent hidden:

```
Start-Process .venv\Scripts\pythonw.exe -ArgumentList "main.py","run" -WorkingDirectory (Get-Location)
```

Logs are in `agent\data\agent.log`.

## Updating later

```
cd ~\jarvis
git pull
cd agent
py main.py setup
```

Then restart the laptop (or end `pythonw.exe` in Task Manager and run the Start-Process line above).

## If something is wrong

| `doctor` / log says | Fix |
| --- | --- |
| `connection FAILED: ... removed or its token is wrong` | Add the device again on the website and re-run `pair`. |
| `cloudflared not installed` | Re-run its winget line, open a new Terminal. |
| `chrome not installed` | Re-run the Chrome winget line. |
| Apps tab: "No device is streaming apps yet" | Run the SQL migration; check the agent window shows the trycloudflare address. |
| After a Windows Update restart nothing works | The agent starts when someone signs in. Sign in once, or set up automatic sign-in. |
