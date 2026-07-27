# install-cli.ps1 — stage the built TASS CLI to %LOCALAPPDATA%\Programs\tass-cli and put `tass`
# on the user PATH. Requires Node >= 22 on PATH (the CLI is a node program; single-exe
# packaging + signing arrive with the S0 rails). Re-run after rebuilding to update.
# Uninstall: -Uninstall removes the install dir and the PATH entry.
#
# The install dir is tass-cli, NOT tass: %LOCALAPPDATA%\Programs\TASS is (case-insensitively)
# the legacy v1 desktop app's Inno install dir, and TASS.exe would shadow tass.cmd on PATH
# (PATHEXT prefers .EXE). Learned the hard way 2026-07-15. The marker file below is the
# only thing this script will ever agree to delete over.
param([switch]$Uninstall)

$ErrorActionPreference = 'Stop'
$pkg = Split-Path -Parent $PSScriptRoot                     # packages/tass-cli
$packagesRoot = Split-Path -Parent $pkg
# Workspace packages staged under node_modules: core + project are required; stats is the
# optional plugin (staged when built, skipped otherwise — the CLI degrades gracefully).
$required = @('tass-core', 'tass-project')
$optional = @('tass-stats', 'tass-viz')
$dest = Join-Path $env:LOCALAPPDATA 'Programs\tass-cli'
$marker = Join-Path $dest '.tass-cli-install'

function Update-UserPath([string]$entry, [bool]$remove) {
    $cur = [Environment]::GetEnvironmentVariable('Path', 'User') ?? ''
    $parts = $cur.Split(';') | Where-Object { $_ -and $_ -ne $entry }
    if (-not $remove) { $parts = @($parts) + $entry }
    [Environment]::SetEnvironmentVariable('Path', ($parts -join ';'), 'User')
}

if ($Uninstall) {
    if (Test-Path $dest) {
        if (-not (Test-Path $marker)) { throw "$dest has no install marker — not ours, refusing to delete" }
        Remove-Item -Recurse -Force $dest
    }
    Update-UserPath $dest $true
    Write-Output "tass CLI removed from $dest and user PATH."
    return
}

if (-not (Test-Path (Join-Path $pkg 'lib\cli.js'))) { throw 'build first: npm run build at the repo root' }
foreach ($name in $required) {
    if (-not (Test-Path (Join-Path $packagesRoot "$name\lib\index.js"))) { throw 'build first: npm run build at the repo root' }
}
if ((Test-Path $dest) -and -not (Test-Path $marker)) {
    throw "$dest exists but has no install marker — refusing to install over foreign files"
}

# Stage: CLI package + real copies of the workspace packages under its node_modules (no
# junctions — the install must survive the dev tree moving or being deleted).
$app = Join-Path $dest 'app'
if (Test-Path $app) { Remove-Item -Recurse -Force $app }
foreach ($d in 'bin', 'lib') { Copy-Item -Recurse (Join-Path $pkg $d) (Join-Path $app $d) }
Copy-Item (Join-Path $pkg 'package.json') $app
$staged = @()
foreach ($name in $required + $optional) {
    $src = Join-Path $packagesRoot $name
    if (-not (Test-Path (Join-Path $src 'lib\index.js'))) { continue }   # unbuilt optional
    $mod = "$app\node_modules\@simdad\$name"
    $null = New-Item -ItemType Directory -Force $mod
    foreach ($d in 'lib', 'data') {
        if (Test-Path (Join-Path $src $d)) { Copy-Item -Recurse (Join-Path $src $d) "$mod\$d" }
    }
    Copy-Item (Join-Path $src 'package.json') $mod
    $staged += $name
}
Write-Output "staged workspace packages: $($staged -join ', ')"

# Launcher shim + ownership marker.
@"
@echo off
node "%LOCALAPPDATA%\Programs\tass-cli\app\bin\tass.js" %*
"@ | Set-Content -Encoding ascii (Join-Path $dest 'tass.cmd')
Set-Content -Encoding ascii $marker "installed by simdad-tass-cli scripts/install-cli.ps1"

Update-UserPath $dest $false
Write-Output "tass CLI installed to $dest (user PATH updated — new shells will see 'tass')."
