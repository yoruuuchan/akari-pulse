[CmdletBinding()]
param(
    [string]$BindHost = '127.0.0.1',
    [int[]]$CandidatePorts = @(18787, 28787, 38787)
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$projectRoot = Split-Path -Parent $PSScriptRoot
$node = (Get-Command node -ErrorAction Stop).Source
$port = $CandidatePorts |
    Where-Object { -not (Get-NetTCPConnection -LocalPort $_ -State Listen -ErrorAction SilentlyContinue) } |
    Select-Object -First 1
if (-not $port) { throw 'No candidate smoke-test port is available.' }

$tempBase = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath())
$temporaryDirectory = [System.IO.Path]::GetFullPath(
    (Join-Path $tempBase ("akari-service-smoke-{0}" -f [guid]::NewGuid().ToString('N')))
)
if (-not $temporaryDirectory.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Resolved smoke-test directory is outside the system temporary directory.'
}
New-Item -ItemType Directory -Path $temporaryDirectory | Out-Null

$savedEnvironment = @{
    Host = $env:AKARI_HEALTH_HOST
    Port = $env:AKARI_HEALTH_PORT
    Database = $env:AKARI_HEALTH_DB
    Token = $env:AKARI_HEALTH_TOKEN
}
$token = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
$process = $null

try {
    $env:AKARI_HEALTH_HOST = $BindHost
    $env:AKARI_HEALTH_PORT = [string]$port
    $env:AKARI_HEALTH_DB = Join-Path $temporaryDirectory 'health.sqlite'
    $env:AKARI_HEALTH_TOKEN = $token

    $process = Start-Process `
        -FilePath $node `
        -ArgumentList @('server\src\index.js') `
        -WorkingDirectory $projectRoot `
        -WindowStyle Hidden `
        -RedirectStandardOutput (Join-Path $temporaryDirectory 'stdout.log') `
        -RedirectStandardError (Join-Path $temporaryDirectory 'stderr.log') `
        -PassThru

    $baseUrl = "http://${BindHost}:${port}"
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
    if (-not $health -or -not $health.ok) {
        $stderr = Get-Content -LiteralPath (Join-Path $temporaryDirectory 'stderr.log') -Raw -ErrorAction SilentlyContinue
        throw "Akari Health did not become ready. $stderr"
    }

    $status = Invoke-RestMethod `
        -NoProxy `
        -Uri "$baseUrl/v1/status" `
        -Headers @{ Authorization = "Bearer $token" } `
        -TimeoutSec 3

    $unauthorizedStatus = $null
    try {
        Invoke-WebRequest -NoProxy -Uri "$baseUrl/v1/status" -TimeoutSec 3 -ErrorAction Stop | Out-Null
        $unauthorizedStatus = 'unexpected-pass'
    }
    catch {
        $unauthorizedStatus = [string]$_.Exception.Response.StatusCode
    }

    [pscustomobject]@{
        bind = $BindHost
        port = $port
        health = $health.status
        database = $status.data.layers.database.status
        backend_ingest = $status.data.layers.backend_ingest.status
        unauthorized_request = $unauthorizedStatus
    }
}
finally {
    if ($process) {
        if (-not $process.HasExited) {
            Stop-Process -Id $process.Id
            Wait-Process -Id $process.Id -Timeout 5 -ErrorAction SilentlyContinue
        }
        $process.Dispose()
        $process = $null
    }
    $env:AKARI_HEALTH_HOST = $savedEnvironment.Host
    $env:AKARI_HEALTH_PORT = $savedEnvironment.Port
    $env:AKARI_HEALTH_DB = $savedEnvironment.Database
    $env:AKARI_HEALTH_TOKEN = $savedEnvironment.Token
    if (Test-Path -LiteralPath $temporaryDirectory) {
        $resolvedCleanup = [System.IO.Path]::GetFullPath($temporaryDirectory)
        if (-not $resolvedCleanup.StartsWith($tempBase, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw 'Refusing to clean an unverified path.'
        }
        for ($attempt = 0; $attempt -lt 20; $attempt += 1) {
            try {
                Remove-Item -LiteralPath $resolvedCleanup -Recurse -Force
                break
            }
            catch [System.IO.IOException] {
                if ($attempt -eq 19) { throw }
                Start-Sleep -Milliseconds 100
            }
        }
    }
}
