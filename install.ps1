<#
JARVIS laptop installer (Windows 10/11). Installs everything the device agent
needs, downloads JARVIS, pairs this computer, signs in Claude Code, and starts
JARVIS hidden with Windows. Safe to run again: it updates instead.

  install.cmd                         (double-click)
  install.cmd -PairCode <code>        (skip the pairing question)
  install.cmd -Repo owner/name        (your copy of the repo, default kingxxasavan/jarvis)
#>
param(
  [string]$PairCode = "",
  [string]$Repo = "kingxxasavan/jarvis",
  [switch]$NoVSCode
)

# Continue, not Stop: Windows PowerShell 5.1 turns any stderr line from git/winget into a fatal error under Stop.
# Each step checks its own exit code instead.
$ErrorActionPreference = "Continue"
$ProgressPreference = "SilentlyContinue"

function Step($text) { Write-Host "`n==> $text" -ForegroundColor Cyan }
function Ok($text) { Write-Host "    $text" -ForegroundColor Green }
function Warn($text) { Write-Host "    $text" -ForegroundColor Yellow }
function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }
function Refresh-Path {
  $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User") + ";$HOME\.local\bin"
}

function Winget($id, $label) {
  Write-Host "    $label" -NoNewline
  winget install -e --id $id --accept-package-agreements --accept-source-agreements --silent --disable-interactivity *> $null
  # 0 = installed; -1978335189 / -1978335135 = already installed / no newer version
  if ($LASTEXITCODE -eq 0 -or $LASTEXITCODE -eq -1978335189 -or $LASTEXITCODE -eq -1978335135) { Write-Host "  ok" -ForegroundColor Green }
  else { Write-Host "  (winget exit $LASTEXITCODE, continuing)" -ForegroundColor Yellow }
}

Write-Host "J.A.R.V.I.S. installer" -ForegroundColor Cyan

# 1. Tools ------------------------------------------------------------------------
Step "Installing tools (first run takes a few minutes)"
if (-not (Have winget)) {
  throw "winget is missing. Open the Microsoft Store, update 'App Installer', then run install.cmd again."
}
Winget "Git.Git" "Git"
Winget "Python.Python.3.12" "Python 3.12"
Winget "Google.Chrome" "Google Chrome"
Winget "Cloudflare.cloudflared" "cloudflared (secure tunnel for Apps and Files)"
Winget "GitHub.cli" "GitHub CLI"
Winget "OpenJS.NodeJS.LTS" "Node.js"
Winget "Anthropic.Claude" "Claude desktop app"
if (-not $NoVSCode) { Winget "Microsoft.VisualStudioCode" "VS Code" }
Refresh-Path

# 2. Claude Code ----------------------------------------------------------------------
Step "Claude Code"
if (-not (Have claude)) {
  try {
    Invoke-RestMethod https://claude.ai/install.ps1 | Invoke-Expression
    Refresh-Path
  } catch { Warn "The Claude Code installer failed: $($_.Exception.Message)" }
}
if (Have claude) { Ok "installed: $((Get-Command claude).Source)" } else { Warn "Claude Code is not installed. JARVIS writes code itself until it is." }
$userPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($userPath -notlike "*\.local\bin*") { [Environment]::SetEnvironmentVariable("Path", "$userPath;$HOME\.local\bin", "User") }
if (Have npm) {
  Write-Host "    Codex (optional)" -NoNewline
  npm install -g @openai/codex *> $null
  Write-Host "  done" -ForegroundColor Green
}

# 3. GitHub sign-in and the JARVIS code ----------------------------------------------------
Step "GitHub"
gh auth status *> $null
if ($LASTEXITCODE -ne 0) {
  Write-Host "    A browser opens: sign in to GitHub (choose HTTPS, then 'Login with a web browser')."
  gh auth login --hostname github.com --git-protocol https --web
}
gh auth setup-git *> $null
if (-not (git config --global user.name)) {
  $login = gh api user --jq .login
  $id = gh api user --jq .id
  git config --global user.name $login
  git config --global user.email "$id+$login@users.noreply.github.com"
}
Ok "signed in"

Step "Getting JARVIS"
$here = Split-Path -Parent $MyInvocation.MyCommand.Path
if (Test-Path (Join-Path $here ".git")) {
  $root = $here
} else {
  $root = Join-Path $HOME "jarvis"
}
# Stop a running agent so its files can be updated.
Get-CimInstance Win32_Process -Filter "Name='pythonw.exe' OR Name='python.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.CommandLine -like '*main.py*run*' -or $_.CommandLine -like '*main.py"*' } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
if (Test-Path (Join-Path $root ".git")) {
  git -C $root pull --ff-only
  if ($LASTEXITCODE -eq 0) { Ok "updated $root" } else { Warn "Could not fast-forward $root (local changes?). Continuing with what is there." }
} elseif (Test-Path $root) {
  # A downloaded ZIP extracted here: turn the folder into a real checkout so updates work.
  git -C $root init -q
  git -C $root remote remove origin *> $null
  git -C $root remote add origin "https://github.com/$Repo.git"
  git -C $root fetch -q origin main
  if ($LASTEXITCODE -ne 0) { throw "Could not download $Repo. Check the name and that this GitHub account can see it." }
  git -C $root checkout -q -f -B main origin/main
  git -C $root branch -q -u origin/main main
  Ok "linked $root to GitHub"
} else {
  gh repo clone $Repo $root
  if ($LASTEXITCODE -ne 0) { throw "Could not download $Repo. Check the name and that this GitHub account can see it." }
  Ok "downloaded to $root"
}
$agent = Join-Path $root "agent"
Set-Location $agent

# 4. Agent ----------------------------------------------------------------------------
Step "Setting up the agent"
py -3.12 main.py setup
if ($LASTEXITCODE -ne 0) { py main.py setup }
if ($LASTEXITCODE -ne 0) { throw "Agent setup failed (see above)." }

$envFile = Join-Path $agent ".env"
$paired = (Test-Path $envFile) -and ((Get-Content $envFile -Raw) -match "DEVICE_TOKEN=\S")
if (-not $paired) {
  Step "Pairing this computer"
  if (-not $PairCode) {
    Write-Host "    In JARVIS open Settings > Devices, type a name (Laptop) and press Add device."
    Write-Host "    Copy the command it shows and paste it here (all of it is fine)."
    $PairCode = Read-Host "    Pair code"
  }
  $PairCode = ($PairCode -replace '^.*\bpair\s+', '').Trim()
  py main.py pair $PairCode
  if ($LASTEXITCODE -ne 0) { throw "Pairing failed. Add the device again in Settings > Devices and rerun install.cmd." }
} else {
  Ok "already paired"
}

if (Have claude) {
  Step "Signing in Claude Code (once; uses your Claude account, no API key)"
  py main.py claude-login
}

# 5. Always on --------------------------------------------------------------------------
Step "Keeping the laptop awake and unlocked for JARVIS"
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_BUTTONS LIDACTION 0
powercfg /setacvalueindex SCHEME_CURRENT SUB_NONE CONSOLELOCK 0
powercfg /setactive SCHEME_CURRENT
Ok "never sleeps on the charger, lid close does nothing, no password on wake"

Step "Starting JARVIS"
py main.py autostart on
Start-Process (Join-Path $agent ".venv\Scripts\pythonw.exe") -ArgumentList "main.py", "run" -WorkingDirectory $agent
Start-Sleep -Seconds 8
py main.py doctor

Write-Host "`nDone. JARVIS runs in the background and starts with Windows." -ForegroundColor Green
Write-Host "Logs: $agent\data\agent.log    Update later: run install.cmd again, or Code > Update from GitHub."
