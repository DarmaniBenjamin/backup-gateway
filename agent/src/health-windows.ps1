# Windows health, for the agent's health monitor (health.js). Prints one JSON object. Read-only:
# Windows' event logs since -Since, drives, Windows Update and Defender. Runs as SYSTEM.
param([string]$Since)
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

try { $sinceDate = [datetime]::Parse($Since).ToLocalTime() } catch { $sinceDate = (Get-Date).AddMinutes(-15) }
$os = Get-CimInstance Win32_OperatingSystem
$r = [ordered]@{
  now      = (Get-Date).ToUniversalTime().ToString('o')
  lastBoot = if ($os.LastBootUpTime) { $os.LastBootUpTime.ToUniversalTime().ToString('o') } else { $null }
  os       = "$($os.Caption) $($os.Version)".Trim()
}

# Crashes (1001 BugCheck), power loss / improper shutdown (41 Kernel-Power, 6008), Windows Update
# install failed (20) and started (43)
$events = Get-WinEvent -FilterHashtable @{ LogName = 'System'; Id = 41, 6008, 1001, 20, 43; StartTime = $sinceDate } -MaxEvents 100
$r.events = @($events | ForEach-Object {
  [ordered]@{
    id       = $_.Id
    provider = $_.ProviderName
    at       = $_.TimeCreated.ToUniversalTime().ToString('o')
    msg      = (($_.Message -split "`r?`n") | Where-Object { $_.Trim() } | Select-Object -First 1)
  }
})

# Drives: free space on local disks, and each physical disk's health
$r.disks = @(Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  [ordered]@{ name = $_.DeviceID; size = [double]$_.Size; free = [double]$_.FreeSpace }
})
$r.physical = @(Get-PhysicalDisk | ForEach-Object {
  [ordered]@{ name = $_.FriendlyName; health = "$($_.HealthStatus)" }
})

# A restart waiting to finish installing updates
$r.rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired') -or
                   (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')

# Defender: only when it's the antivirus in charge ("Normal"); with another antivirus it steps back
# ("Passive") and being off is expected
$mp = Get-MpComputerStatus
if ($mp) {
  $r.defender = [ordered]@{ mode = "$($mp.AMRunningMode)"; realTime = [bool]$mp.RealTimeProtectionEnabled; antivirus = [bool]$mp.AntivirusEnabled }
  if (-not $mp.AMRunningMode -and $mp.AMServiceEnabled) { $r.defender.mode = 'Normal' }
}
$r.threats = @(Get-MpThreatDetection | Where-Object { $_.InitialDetectionTime -gt $sinceDate } | ForEach-Object {
  [ordered]@{ name = (Get-MpThreat -ThreatID $_.ThreatID).ThreatName; at = $_.InitialDetectionTime.ToUniversalTime().ToString('o') }
})

$r | ConvertTo-Json -Depth 4 -Compress
