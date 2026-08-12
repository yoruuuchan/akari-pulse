[CmdletBinding()]
param(
    [int[]]$CandidatePorts = @(18788, 28788, 38788)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$temporaryBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $temporaryBase ("akari-package-verify-{0}" -f [guid]::NewGuid().ToString('N')))
)
if (-not $temporaryRoot.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved package-test directory is outside the system temporary directory.'
}

$serverDirectory = Join-Path $temporaryRoot 'server'
$mcpDirectory = Join-Path $temporaryRoot 'mcp'
New-Item -ItemType Directory -Path $serverDirectory, $mcpDirectory | Out-Null

$savedEnvironment = @{
    Host = $env:AKARI_HEALTH_HOST
    Port = $env:AKARI_HEALTH_PORT
    Database = $env:AKARI_HEALTH_DB
    Token = $env:AKARI_HEALTH_TOKEN
}
$process = $null

try {
    tar -xzf (Join-Path $projectRoot 'artifacts\akari-pulse-server-0.1.0.tgz') -C $serverDirectory --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'Server archive extraction failed.' }
    tar -xzf (Join-Path $projectRoot 'artifacts\akari-pulse-mcp-0.1.0.tgz') -C $mcpDirectory --strip-components=1
    if ($LASTEXITCODE -ne 0) { throw 'MCP archive extraction failed.' }

    Push-Location $serverDirectory
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Packaged server tests failed.' }
    Pop-Location

    Push-Location $mcpDirectory
    npm install --ignore-scripts --no-audit --no-fund
    if ($LASTEXITCODE -ne 0) { throw 'Packaged MCP dependency install failed.' }
    npm test
    if ($LASTEXITCODE -ne 0) { throw 'Packaged MCP tests failed.' }
    Pop-Location

    $port = $CandidatePorts |
        Where-Object { -not (Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue) } |
        Select-Object -First 1
    if (-not $port) { throw 'No package-test port is available.' }

    $env:AKARI_HEALTH_HOST = '127.0.0.1'
    $env:AKARI_HEALTH_PORT = [string]$port
    $env:AKARI_HEALTH_DB = Join-Path $temporaryRoot 'health.sqlite'
    $env:AKARI_HEALTH_TOKEN = [guid]::NewGuid().ToString('N')
    $process = Start-Process `
        -FilePath (Get-Command node -ErrorAction Stop).Source `
        -ArgumentList @('src\index.js') `
        -WorkingDirectory $serverDirectory `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $temporaryRoot 'stdout.log') `
        -RedirectStandardError (Join-Path $temporaryRoot 'stderr.log') `
        -PassThru

    $baseUrl = "http://127.0.0.1:$port"
    $health = $null
    for ($attempt = 0; $attempt -lt 40; $attempt += 1) {
        try {
            $health = Invoke-RestMethod -NoProxy -Uri "$baseUrl/healthz" -TimeoutSec 1
            if ($health.ok) { break }
        }
        catch {
            Start-Sleep -Milliseconds 250
        }
    }
    if (-not $health -or -not $health.ok) { throw 'Packaged service did not become ready.' }

    $status = Invoke-RestMethod `
        -NoProxy `
        -Uri "$baseUrl/v1/status" `
        -Headers @{ Authorization = "Bearer $($env:AKARI_HEALTH_TOKEN)" } `
        -TimeoutSec 3

    try {
        Invoke-WebRequest -NoProxy -Uri "$baseUrl/v1/status" -TimeoutSec 3 -ErrorAction Stop | Out-Null
        throw 'Unauthenticated packaged-service request unexpectedly passed.'
    }
    catch {
        if ([int]$_.Exception.Response.StatusCode -ne 401) { throw }
    }

    [pscustomobject]@{
        archive_server_tests = 'PASS'
        archive_mcp_tests = 'PASS'
        archive_service_health = $health.status
        archive_database = $status.data.layers.database.status
        archive_backend_ingest = $status.data.layers.backend_ingest.status
        archive_unauthorized = '401'
    }
}
finally {
    if ((Get-Location).Path -ne $projectRoot) {
        Pop-Location -ErrorAction SilentlyContinue
    }
    if ($process) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id
            Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
        $process.Dispose()
    }
    $env:AKARI_HEALTH_HOST = $savedEnvironment.Host
    $env:AKARI_HEALTH_PORT = $savedEnvironment.Port
    $env:AKARI_HEALTH_DB = $savedEnvironment.Database
    $env:AKARI_HEALTH_TOKEN = $savedEnvironment.Token
    if (Test-Path -LiteralPath $temporaryRoot) {
        $resolvedCleanup = [System.IO.Path]::GetFullPath($temporaryRoot)
        if (-not $resolvedCleanup.StartsWith($temporaryBase, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean an unverified path.'
        }
        Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
    }
}
