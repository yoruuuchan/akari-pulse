[CmdletBinding()]
param(
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [string]$DatabasePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $env:AKARI_HEALTH_TOKEN) {
    throw 'Set AKARI_HEALTH_TOKEN before exposing Akari Health to the tailnet.'
}

$tailscale = Get-Command tailscale -ErrorAction Stop
$tailnetIp = (& $tailscale.Source ip -4 | Select-Object -First 1).Trim()
$parsedIp = $null
if (-not [System.Net.IPAddress]::TryParse($tailnetIp, [ref]$parsedIp) -or $parsedIp.AddressFamily -ne 'InterNetwork') {
    throw 'Tailscale did not return a usable IPv4 address. Confirm that this device is connected.'
}

$arguments = @('-BindHost', $tailnetIp, '-Port', $Port)
if ($DatabasePath) { $arguments += @('-DatabasePath', $DatabasePath) }
& (Join-Path $PSScriptRoot 'start-server.ps1') @arguments
exit $LASTEXITCODE

