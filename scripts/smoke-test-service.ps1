[CmdletBinding()]
param(
    [string]$ServiceUrl = 'http://127.0.0.1:8787'
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

$health = Invoke-RestMethod -Uri "$($ServiceUrl.TrimEnd('/'))/healthz" -Method Get
if (-not $health.ok -or $health.status -ne 'PASS') {
    throw 'Akari Health liveness check did not return PASS.'
}

$headers = @{}
if ($env:AKARI_HEALTH_TOKEN) {
    $headers.Authorization = "Bearer $($env:AKARI_HEALTH_TOKEN)"
}
$status = Invoke-RestMethod -Uri "$($ServiceUrl.TrimEnd('/'))/v1/status" -Method Get -Headers $headers
if (-not $status.ok -or $status.data.layers.database.status -ne 'PASS') {
    throw 'Akari Health status check did not return a healthy database layer.'
}

[pscustomobject]@{
    service = $health.service
    liveness = $health.status
    database = $status.data.layers.database.status
    backend_ingest = $status.data.layers.backend_ingest.status
    record_count = $status.data.database.record_count
}

