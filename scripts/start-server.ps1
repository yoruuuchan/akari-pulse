[CmdletBinding()]
param(
    [string]$BindHost = '127.0.0.1',
    [ValidateRange(1, 65535)]
    [int]$Port = 8787,
    [string]$DatabasePath = ''
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction Stop

$env:AKARI_HEALTH_HOST = $BindHost
$env:AKARI_HEALTH_PORT = [string]$Port
if ($DatabasePath) {
    $env:AKARI_HEALTH_DB = [System.IO.Path]::GetFullPath($DatabasePath)
}

if ($BindHost -notin @('127.0.0.1', 'localhost', '::1') -and -not $env:AKARI_HEALTH_TOKEN) {
    throw 'Set AKARI_HEALTH_TOKEN before binding Akari Health beyond loopback.'
}

& $node.Source (Join-Path $projectRoot 'server\src\index.js')
exit $LASTEXITCODE

