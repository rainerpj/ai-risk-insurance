$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$nodeDirectory = Join-Path $projectRoot ".local/toolchains/node-v$($manifest.engines.node)-win-x64"
$nodeExecutable = Join-Path $nodeDirectory 'node.exe'
if (!(Test-Path -LiteralPath $nodeExecutable)) {
    throw 'Project Node is missing. Run scripts/setup-node.ps1 first.'
}
if ((& $nodeExecutable --version) -ne "v$($manifest.engines.node)") { throw 'Project Node version mismatch.' }
$pnpmEntry = Join-Path $env:USERPROFILE '.cache/codex-runtimes/codex-primary-runtime/dependencies/node/node_modules/pnpm/bin/pnpm.mjs'
if (!(Test-Path -LiteralPath $pnpmEntry)) { throw 'Shared pnpm is missing. Refresh Codex workspace dependencies.' }
if ((& $nodeExecutable $pnpmEntry --version) -ne $manifest.packageManager.Split('@')[1]) { throw 'Shared pnpm version mismatch.' }
# Nested package scripts call `pnpm`; keep those on the same Node as the outer process.
$shim = '@echo off' + "`r`n" + '"%~dp0node.exe" "' + $pnpmEntry + '" %*' + "`r`n"
Set-Content -LiteralPath (Join-Path $nodeDirectory 'pnpm.cmd') -Value $shim -Encoding utf8
$originalPath = $env:PATH
$resultCode = 1
Push-Location $projectRoot
try {
    $env:PATH = $nodeDirectory + ';' + $originalPath
    & $nodeExecutable $pnpmEntry @args
    $resultCode = $LASTEXITCODE
} finally {
    $env:PATH = $originalPath
    Pop-Location
}
exit $resultCode
