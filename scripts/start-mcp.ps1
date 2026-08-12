[CmdletBinding()]
param(
    [string]$ServiceUrl = 'http://127.0.0.1:8787'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = Get-Command node -ErrorAction Stop
$env:AKARI_HEALTH_URL = $ServiceUrl

& $node.Source (Join-Path $projectRoot 'mcp\src\index.js')
exit $LASTEXITCODE

