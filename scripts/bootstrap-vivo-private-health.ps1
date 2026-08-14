<#
.SYNOPSIS
Owner bootstrap for the vivo private health providers used by Akari Pulse.

.DESCRIPTION
`com.vivo.health.widget.permission` is declared `signature|privileged`, so a third-party build
never receives it at install time. On the verified device the owner can grant it once over ADB,
after which Akari Pulse can read `content://com.vivo.health.provider/sleep` and
`content://com.vivo.health.provider.care/healthCare` read-only.

The script grants the permission and then independently verifies it through `dumpsys package`.
A silent `pm grant` is not treated as success: only the dumpsys read-back decides PASS or FAIL.

Reinstalling the APK clears the grant. Re-run this script after every install, and after a
factory reset, a device swap, or any system update that resets permissions.

Verified only on vivo X200 Pro (V2405A / PD2405, Android 15). Other vivo or iQOO models and
firmware versions are unverified; on a device whose ROM refuses the grant, the script reports
FAIL and Akari Pulse reports NOT_GRANTED rather than substituting data.

This changes permission state for Akari Pulse only. It does not modify vivo Health, its
database, or any system component.

.PARAMETER Serial
ADB serial to target. Required only when more than one device is attached.

.PARAMETER Package
Application id to grant. Defaults to the Akari Pulse bridge.

.PARAMETER Revoke
Revoke the permission instead of granting it, and verify the revocation.

.EXAMPLE
pwsh -File scripts/bootstrap-vivo-private-health.ps1

.EXAMPLE
pwsh -File scripts/bootstrap-vivo-private-health.ps1 -Revoke
#>
[CmdletBinding()]
param(
    [string] $Serial,
    [string] $Package = 'dev.akari.pulse.bridge',
    [switch] $Revoke
)

$ErrorActionPreference = 'Stop'

$permission = 'com.vivo.health.widget.permission'
$providerAuthorities = @('com.vivo.health.provider', 'com.vivo.health.provider.care')

function Invoke-Adb {
    param([Parameter(Mandatory)][string[]] $Arguments)

    $full = @()
    if ($Serial) { $full += @('-s', $Serial) }
    $full += $Arguments
    $output = & adb @full 2>&1
    return [pscustomobject]@{
        ExitCode = $LASTEXITCODE
        Output   = ($output | Out-String)
    }
}

function Write-Result {
    param([string] $Verdict, [string] $Message)
    Write-Output ''
    Write-Output "$Verdict  $Message"
}

if (-not (Get-Command adb -ErrorAction SilentlyContinue)) {
    Write-Result 'FAIL' 'adb was not found on PATH. Install Android platform-tools and retry.'
    exit 1
}

$devicesRaw = (& adb devices) | Out-String
$devices = @(
    $devicesRaw -split "`r?`n" |
        Select-Object -Skip 1 |
        Where-Object { $_ -match '^\S+\s+device$' } |
        ForEach-Object { ($_ -split '\s+')[0] }
)

if ($devices.Count -eq 0) {
    Write-Result 'FAIL' 'No authorized device is attached. Enable USB debugging and accept the prompt on the phone.'
    exit 1
}
if ($devices.Count -gt 1 -and -not $Serial) {
    Write-Result 'FAIL' ("More than one device is attached ({0}). Re-run with -Serial <serial>." -f ($devices -join ', '))
    exit 1
}
if ($Serial -and $devices -notcontains $Serial) {
    Write-Result 'FAIL' "Serial $Serial is not among the attached devices: $($devices -join ', ')"
    exit 1
}

$target = if ($Serial) { $Serial } else { $devices[0] }
$model = (Invoke-Adb @('shell', 'getprop', 'ro.product.model')).Output.Trim()
$release = (Invoke-Adb @('shell', 'getprop', 'ro.build.version.release')).Output.Trim()
Write-Output "device      $target ($model, Android $release)"
Write-Output "package     $Package"
Write-Output "permission  $permission"

$installed = Invoke-Adb @('shell', 'pm', 'path', $Package)
if ($installed.ExitCode -ne 0 -or $installed.Output -notmatch 'package:') {
    Write-Result 'FAIL' "$Package is not installed on $target. Install the APK first, then re-run."
    exit 1
}

foreach ($authority in $providerAuthorities) {
    $probe = Invoke-Adb @('shell', 'dumpsys', 'package', 'providers')
    if ($probe.Output -notmatch [regex]::Escape($authority)) {
        Write-Result 'FAIL' "Provider authority $authority does not exist on this device. This route is UNSUPPORTED here."
        exit 1
    }
}
Write-Output "providers   $($providerAuthorities -join ', ') present"

$action = if ($Revoke) { 'revoke' } else { 'grant' }
$change = Invoke-Adb @('shell', 'pm', $action, $Package, $permission)
$changeOutput = $change.Output.Trim()
if ($changeOutput) { Write-Output "pm $action    $changeOutput" }

# `pm grant` can exit 0 without changing anything on a ROM that refuses non-runtime permissions,
# so the verdict comes from dumpsys, never from the grant command's exit code.
$dump = Invoke-Adb @('shell', 'dumpsys', 'package', $Package)
if ($dump.ExitCode -ne 0) {
    Write-Result 'FAIL' "dumpsys package $Package failed; the grant could not be verified."
    exit 1
}

$granted = $null
foreach ($line in ($dump.Output -split "`r?`n")) {
    if ($line -match [regex]::Escape($permission)) {
        if ($line -match 'granted=(true|false)') { $granted = $Matches[1] -eq 'true' }
    }
}

if ($null -eq $granted) {
    Write-Result 'FAIL' "$permission is not listed for $Package. Rebuild with the permission declared in AndroidManifest.xml."
    exit 1
}

Write-Output "dumpsys     granted=$granted"

if ($Revoke) {
    if ($granted) {
        Write-Result 'FAIL' "$permission is still granted after pm revoke."
        exit 1
    }
    Write-Result 'PASS' "$permission is revoked. Akari Pulse will now report NOT_GRANTED for the vivo private providers."
    exit 0
}

if (-not $granted) {
    Write-Result 'FAIL' "$permission is still not granted. This ROM refuses the grant; the vivo private route is unavailable here."
    exit 1
}

Write-Result 'PASS' "$permission is GRANTED. Open Akari Pulse and use 'read sleep and vitals'; the app's capability card must also show GRANTED."
Write-Output 'Reinstalling the APK clears this grant. Re-run this script after every install.'
exit 0
