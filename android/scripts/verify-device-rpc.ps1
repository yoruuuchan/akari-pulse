$ErrorActionPreference = 'Stop'

$expected = '38b9c774b7c52b16f2ba7018c37864529e8656166e3db438c864ebc6043c95de'
$aar = Join-Path $PSScriptRoot '..\app\libs\device-rpc-1.0.0.17.aar'
$actual = (Get-FileHash -Algorithm SHA256 -LiteralPath $aar).Hash.ToLowerInvariant()

if ($actual -ne $expected) {
    throw "device-rpc AAR SHA-256 mismatch: expected $expected, got $actual"
}

Write-Output "device-rpc 1.0.0.17 SHA-256 verified: $actual"
