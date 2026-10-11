<#
  Installs (or upgrades) the backup agent on a Windows PC or server.

  Usually you don't run this by hand: "Add device" in the gateway's web UI gives a one-line
  PowerShell or Command Prompt command, or a setup .exe, that downloads the agent from the
  gateway and runs this with everything filled in.

  By hand, in PowerShell as Administrator, from the agent folder:
    powershell -ExecutionPolicy Bypass -File .\install\windows\install.ps1 `
      -Gateway http://192.168.1.10:8080 -Code ABCD-EFGH-JKLM -Allowed "C:\Users;D:\Shared"
  Upgrade (keeps the settings and the device's identity): run it again from a newer copy, no options.

  What it sets up:
    C:\Program Files\BackupAgent\app        the agent's code
    C:\Program Files\BackupAgent\node       its own copy of Node.js (official build, SHA-256 checked)
    C:\ProgramData\BackupAgent\agent.env    settings        } readable by SYSTEM and
    C:\ProgramData\BackupAgent\data         keys, database  } Administrators only
    C:\ProgramData\BackupAgent\agent.log    the agent's log
    Scheduled task "BackupAgent"            starts with Windows as SYSTEM (can read every user's
                                            files), at below-normal priority, restarts if it stops
#>
#Requires -Version 5.1
param(
  [string]$Gateway = "",
  [string]$Code = "",
  [string]$Allowed = "",
  [string]$Watch = "",
  [string]$Name = ""
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue" # progress bars make downloads very slow in Windows PowerShell
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

$TaskName = "BackupAgent"
$Prefix = Join-Path $env:ProgramFiles "BackupAgent"
$DataRoot = Join-Path $env:ProgramData "BackupAgent"
$Conf = Join-Path $DataRoot "agent.env"
$DataDir = Join-Path $DataRoot "data"
$LogFile = Join-Path $DataRoot "agent.log"
$NodeMin = [version]"22.13.0"
$NodeDist = if ($env:NODE_DIST) { $env:NODE_DIST } else { "https://nodejs.org/dist/latest-v22.x" }
$Src = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path

function Ok($text) { Write-Host "  [OK] $text" -ForegroundColor Green }
function Step($text) { Write-Host $text -ForegroundColor Cyan }

function Read-Setting($key) {
  if (-not (Test-Path $Conf)) { return "" }
  foreach ($line in [IO.File]::ReadAllLines($Conf)) {
    if ($line -match "^$key='(.*)'$") { return $Matches[1] }
  }
  return ""
}

# Settings go in single quotes in agent.env, so they can't contain quotes or line breaks
function Assert-SafeText($label, $value) {
  if ($value -match "['""``\r\n]") { throw "$label can't contain quotes or line breaks: $value" }
}

function Get-NodeVersion($exe) {
  if (-not (Test-Path $exe)) { return $null }
  try { return [version]((& $exe -p "process.versions.node") | Select-Object -First 1) } catch { return $null }
}

function Stop-Agent {
  $task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($task) { Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue }
  # Stopping the task doesn't always end node.exe straight away
  $nodeExe = Join-Path $Prefix "node\node.exe"
  Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
    Where-Object { $_.ExecutablePath -eq $nodeExe } |
    ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
}

function Show-Log {
  Write-Host ""
  Write-Host "Last lines of the agent's log ($LogFile):"
  if (Test-Path $LogFile) { Get-Content $LogFile -Tail 25 } else { Write-Host "  (no log yet)" }
}

try {
  $identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
  if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
    throw "Run this as Administrator (right-click PowerShell or Command Prompt > Run as administrator)."
  }
  if (-not (Test-Path (Join-Path $Src "package.json")) -or -not (Test-Path (Join-Path $Src "src\index.js"))) {
    throw "Run this from inside the agent folder (agent\install\windows\install.ps1)."
  }
  $agentVersion = (Get-Content (Join-Path $Src "package.json") -Raw | ConvertFrom-Json).version
  Write-Host "Backup agent $agentVersion installer" -ForegroundColor White

  # ---- Settings: new values from the options, otherwise what's already installed ----

  $upgrade = Test-Path $Conf
  $enrolled = Test-Path (Join-Path $DataDir "identity.json")
  if (-not $Gateway) { $Gateway = Read-Setting "AGENT_GATEWAY_URL" }
  if (-not $Allowed) { $Allowed = Read-Setting "AGENT_ALLOWED_PATHS" }
  if (-not $Watch) { $Watch = Read-Setting "AGENT_WATCH_DIR" }
  if (-not $Name) { $Name = Read-Setting "AGENT_DEVICE_NAME" }
  if (-not $Name) { $Name = $env:COMPUTERNAME }
  $logLevel = Read-Setting "AGENT_LOG_LEVEL"
  if (-not $logLevel) { $logLevel = "info" }

  if (-not $Gateway) { throw "-Gateway is needed for the first install, e.g. -Gateway http://192.168.1.10:8080" }
  if (-not $Allowed) { throw "-Allowed is needed for the first install, e.g. -Allowed ""C:\Users;D:\Shared""" }
  if ($enrolled) { $Code = "" } # already enrolled: a code is never needed again
  elseif (-not $Code) { throw "-Code is needed: this device isn't enrolled yet. Create a code in the web UI (Devices > Add device)." }

  if ($Gateway -notmatch '^https?://[^\s/]+(/\S*)?$') { throw "-Gateway must look like http://192.168.1.10:8080" }
  $Gateway = $Gateway.TrimEnd("/")
  if ($Code -and $Code -notmatch '^[A-Za-z0-9-]+$') { throw "The enrollment code should only contain letters, numbers and dashes." }
  Assert-SafeText "-Name" $Name

  # Allowed areas: full paths of existing folders, never a whole drive
  $allowedList = @()
  foreach ($part in $Allowed.Split(";")) {
    $p = $part.Trim()
    if (-not $p) { continue }
    Assert-SafeText "Allowed folder" $p
    if ($p -notmatch '^[A-Za-z]:\\') { throw "Allowed folders must be full paths like C:\Users: $p" }
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { throw "Allowed folder doesn't exist: $p" }
    $full = (Get-Item -LiteralPath $p).FullName.TrimEnd("\")
    if ($full -match '^[A-Za-z]:$') { throw "Allowing a whole drive ($full\) isn't supported. List the folders with data instead, e.g. C:\Users." }
    foreach ($bad in @($env:windir, $Prefix, $DataRoot)) {
      if ($full -ieq $bad -or $full.StartsWith("$bad\", [StringComparison]::OrdinalIgnoreCase)) { throw "This folder can't be an allowed folder: $full" }
    }
    $allowedList += $full
  }
  if ($allowedList.Count -eq 0) { throw "-Allowed has no folders in it." }
  $Allowed = $allowedList -join ";"

  if ($Watch) {
    Assert-SafeText "-Watch" $Watch
    if (-not (Test-Path -LiteralPath $Watch -PathType Container)) { throw "-Watch folder doesn't exist: $Watch" }
    $Watch = (Get-Item -LiteralPath $Watch).FullName.TrimEnd("\")
    $inside = $allowedList | Where-Object { $Watch -ieq $_ -or $Watch.StartsWith("$_\", [StringComparison]::OrdinalIgnoreCase) }
    if (-not $inside) { throw "-Watch folder must be inside one of the allowed folders: $Watch" }
  }

  Write-Host "  Gateway:         $Gateway"
  Write-Host "  Allowed folders: $($allowedList -join ', ')"
  if ($Watch) { Write-Host "  First folder:    $Watch" }
  Write-Host "  Device name:     $Name"
  if ($upgrade) { Write-Host "  (upgrading the existing install, the device keeps its identity)" }
  Write-Host ""

  # ---- Node.js: the agent's own copy, from nodejs.org, checked against the official SHA-256 list ----

  $nodeDir = Join-Path $Prefix "node"
  $nodeExe = Join-Path $nodeDir "node.exe"
  $have = Get-NodeVersion $nodeExe
  if (-not $have -or $have -lt $NodeMin) {
    $arch = switch ($env:PROCESSOR_ARCHITECTURE) { "AMD64" { "x64" } "ARM64" { "arm64" } default { $null } }
    if (-not $arch) { throw "No ready-made Node.js for this processor ($env:PROCESSOR_ARCHITECTURE)." }
    Step "Downloading Node.js 22 ($arch)..."
    $tmp = Join-Path $env:TEMP ("backup-agent-node-" + [guid]::NewGuid())
    New-Item -ItemType Directory -Path $tmp | Out-Null
    try {
      $sums = (Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/SHASUMS256.txt").Content
      if ($sums -is [byte[]]) { $sums = [Text.Encoding]::UTF8.GetString($sums) }
      $match = [regex]::Match($sums, "([0-9a-f]{64})\s+(node-v22\.\d+\.\d+-win-$arch\.zip)")
      if (-not $match.Success) { throw "Couldn't find the Node.js download in the official list." }
      $zip = Join-Path $tmp $match.Groups[2].Value
      Invoke-WebRequest -UseBasicParsing -Uri "$NodeDist/$($match.Groups[2].Value)" -OutFile $zip
      if ((Get-FileHash $zip -Algorithm SHA256).Hash -ne $match.Groups[1].Value) {
        throw "The Node.js download failed its SHA-256 check. Nothing was installed."
      }
      Ok "Node.js download verified (SHA-256)"
      Expand-Archive -Path $zip -DestinationPath $tmp
      $unpacked = Get-ChildItem $tmp -Directory | Where-Object { $_.Name -like "node-v22*" } | Select-Object -First 1
      Stop-Agent
      New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
      if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
      Move-Item $unpacked.FullName $nodeDir
    } finally {
      Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
    }
  }
  Ok "Node.js $(Get-NodeVersion $nodeExe) at $nodeExe"

  # ---- The agent's code ----

  Step "Installing the agent..."
  New-Item -ItemType Directory -Path $Prefix -Force | Out-Null
  $stage = Join-Path $Prefix "app.new"
  if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
  New-Item -ItemType Directory -Path $stage | Out-Null
  Copy-Item -Recurse (Join-Path $Src "src") $stage
  Copy-Item (Join-Path $Src "package.json"), (Join-Path $Src "package-lock.json") $stage
  $env:Path = "$nodeDir;$env:Path"
  Push-Location $stage
  try {
    & (Join-Path $nodeDir "npm.cmd") ci --omit=dev --no-audit --no-fund --loglevel=error
    if ($LASTEXITCODE -ne 0) { throw "Installing the agent's packages failed (see above)." }
  } finally {
    Pop-Location
  }
  Ok "agent $agentVersion ready"

  # ---- Settings and data folder: SYSTEM and Administrators only ----

  New-Item -ItemType Directory -Path $DataDir -Force | Out-Null
  # *S-1-5-18 = SYSTEM, *S-1-5-32-544 = Administrators (by ID, so it works in any Windows language)
  & icacls.exe $DataRoot /inheritance:r /grant:r "*S-1-5-18:(OI)(CI)F" "*S-1-5-32-544:(OI)(CI)F" /T /Q | Out-Null
  if ($LASTEXITCODE -ne 0) { throw "Couldn't lock down $DataRoot." }

  $settings = @(
    "# Backup agent settings. Written by install.ps1; run it again to change them.",
    "AGENT_GATEWAY_URL='$Gateway'",
    "AGENT_ALLOWED_PATHS='$Allowed'",
    "AGENT_WATCH_DIR='$Watch'",
    "AGENT_DEVICE_NAME='$Name'",
    "AGENT_DATA_DIR='$DataDir'",
    "AGENT_LOG_FILE='$LogFile'",
    "AGENT_LOG_LEVEL='$logLevel'",
    "AGENT_ENROLL_CODE='$Code'"
  ) -join "`n"
  # UTF-8 without a BOM: Node would read a BOM as part of the first setting's name
  [IO.File]::WriteAllText($Conf, "$settings`n", (New-Object Text.UTF8Encoding $false))
  Ok "settings saved to $Conf"

  # ---- Swap in the new code with the agent stopped, then (re)create the scheduled task ----

  Stop-Agent
  $app = Join-Path $Prefix "app"
  if (Test-Path $app) { Remove-Item -Recurse -Force $app }
  Move-Item $stage $app
  Copy-Item (Join-Path $Src "install\windows\uninstall.ps1") (Join-Path $Prefix "uninstall.ps1") -Force

  $action = New-ScheduledTaskAction -Execute $nodeExe -WorkingDirectory $app `
    -Argument "--disable-warning=ExperimentalWarning --env-file=""$Conf"" ""$(Join-Path $app 'src\index.js')"""
  $trigger = New-ScheduledTaskTrigger -AtStartup
  $principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
  $taskSettings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable `
    -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) `
    -MultipleInstances IgnoreNew -Priority 7
  Register-ScheduledTask -TaskName $TaskName -Description "Backup agent: sends changes to the backup gateway" `
    -Action $action -Trigger $trigger -Principal $principal -Settings $taskSettings -Force | Out-Null
  # A first install starts with a fresh log, so old errors aren't mistaken for new ones
  if (-not $enrolled -and (Test-Path $LogFile)) { Move-Item $LogFile "$LogFile.previous" -Force }
  Start-ScheduledTask -TaskName $TaskName
  Ok "background task $TaskName installed and started"

  # ---- Check that it enrolled ----

  $identityFile = Join-Path $DataDir "identity.json"
  if (-not $enrolled) {
    Write-Host -NoNewline "  waiting for the agent to enroll with the gateway"
    for ($i = 0; $i -lt 45; $i++) {
      if (Test-Path $identityFile) { break }
      if ((Test-Path $LogFile) -and (Select-String -Path $LogFile -Pattern "Enrollment failed|\[ERROR\]" -Quiet)) { break }
      Start-Sleep -Seconds 1
      Write-Host -NoNewline "."
    }
    Write-Host ""
    if (-not (Test-Path $identityFile)) {
      Stop-Agent
      Show-Log
      throw "The agent didn't enroll (see the log above). Check the gateway address, create a new code in the web UI, then run this again. Everything else is already installed."
    }
    # The code was single-use and is spent: take it out of the settings file
    $text = [IO.File]::ReadAllText($Conf) -replace "AGENT_ENROLL_CODE='[^']*'", "AGENT_ENROLL_CODE=''"
    [IO.File]::WriteAllText($Conf, $text, (New-Object Text.UTF8Encoding $false))
    $client = (Get-Content $identityFile -Raw | ConvertFrom-Json).clientName
    Ok "enrolled: client ""$client"""
  } else {
    Start-Sleep -Seconds 3
    if ((Get-ScheduledTask -TaskName $TaskName).State -ne "Running") { Show-Log; throw "The agent stopped right after starting (see the log above)." }
  }

  Write-Host ""
  Write-Host "Done. The agent runs in the background and starts with Windows." -ForegroundColor White
  Write-Host "  Status:     Task Scheduler > $TaskName  (or: Get-ScheduledTask $TaskName)"
  Write-Host "  Log:        $LogFile"
  Write-Host "  Folders:    add or remove them from the gateway's web UI (Devices > this device)"
  Write-Host "  Uninstall:  powershell -ExecutionPolicy Bypass -File ""$(Join-Path $Prefix 'uninstall.ps1')"""
  exit 0
} catch {
  Write-Host ""
  Write-Host "Error: $($_.Exception.Message)" -ForegroundColor Red
  exit 1
}
