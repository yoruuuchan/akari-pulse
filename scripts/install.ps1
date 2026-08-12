[CmdletBinding()]
param(
    [switch]$SkipTests
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$npm = Get-Command npm -ErrorAction Stop

Push-Location $projectRoot
try {
    & $npm.Source ci
    if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE" }
    if (-not $SkipTests) {
        & $npm.Source test
        if ($LASTEXITCODE -ne 0) { throw "npm test failed with exit code $LASTEXITCODE" }
    }
}
finally {
    Pop-Location
}

