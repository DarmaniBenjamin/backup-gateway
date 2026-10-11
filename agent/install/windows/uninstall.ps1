<#
  Removes the backup agent from this Windows computer. The installer keeps a copy of this at
  C:\Program Files\BackupAgent\uninstall.ps1. In PowerShell or Command Prompt as Administrator:

    powershell -ExecutionPolicy Bypass -File "C:\Program Files\BackupAgent\uninstall.ps1"
        removes the agent, keeps its identity and settings (installing again carries on as the same device)
    ... -Purge
        also deletes its identity, keys, settings and log. The device can't reconnect after this;
        add it again to back it up.

  Backups already on the gateway are never touched by this. Remove the device in the web UI too
  if it's gone for good.
#>
#Requires -Version 5.1
param([switch]$Purge)

$ErrorActionPreference = "Stop"
$TaskName = "BackupAgent"
$Prefix = Join-Path $env:ProgramFiles "BackupAgent"
$DataRoot = Join-Path $env:ProgramData "BackupAgent"

$identity = [Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()
if (-not $identity.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
  Write-Host "Run this as Administrator." -ForegroundColor Red
  exit 1
}

if (Get-ScheduledTask -TaskName "$($TaskName)Update" -ErrorAction SilentlyContinue) {
  Unregister-ScheduledTask -TaskName "$($TaskName)Update" -Confirm:$false
}
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
  Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}
$nodeExe = Join-Path $Prefix "node\node.exe"
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" -ErrorAction SilentlyContinue |
  Where-Object { $_.ExecutablePath -eq $nodeExe } |
  ForEach-Object { Invoke-CimMethod -InputObject $_ -MethodName Terminate | Out-Null }
Start-Sleep -Seconds 1

# This script lives in the folder it removes; Windows lets it finish because it's already loaded
if (Test-Path $Prefix) { Remove-Item -Recurse -Force $Prefix -ErrorAction SilentlyContinue }
Write-Host "Removed the backup agent and its background task."

if ($Purge) {
  if (Test-Path $DataRoot) { Remove-Item -Recurse -Force $DataRoot }
  Write-Host "Deleted the device's identity, keys, settings and log."
} else {
  Write-Host "Kept the device's identity and settings ($DataRoot). Run with -Purge to delete those too."
}
