$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path $PSScriptRoot
$manifest = Get-Content -LiteralPath (Join-Path $projectRoot 'package.json') -Raw | ConvertFrom-Json
$nodeVersion = $manifest.engines.node
if ($nodeVersion -notmatch '^\d+\.\d+\.\d+$') { throw 'Expected an exact Node version.' }
$toolchains = Join-Path $projectRoot '.local/toolchains'
$nodeExecutable = Join-Path $toolchains "node-v$nodeVersion-win-x64/node.exe"
if (Test-Path -LiteralPath $nodeExecutable) {
    if ((& $nodeExecutable --version) -ne "v$nodeVersion") { throw 'Existing project Node version mismatch.' }
    Write-Output "Project Node v$nodeVersion already installed."
    exit 0
}
New-Item -ItemType Directory -Force -Path $toolchains | Out-Null
$archiveName = "node-v$nodeVersion-win-x64.zip"
$archive = Join-Path $toolchains $archiveName
$checksums = Join-Path $toolchains "SHASUMS256-v$nodeVersion.txt"
Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/SHASUMS256.txt" -OutFile $checksums
Invoke-WebRequest "https://nodejs.org/dist/v$nodeVersion/$archiveName" -OutFile $archive
# Verify downloaded executable provenance/integrity against the official release manifest.
$checksumLine = Get-Content -LiteralPath $checksums | Where-Object { ($_ -split '\s+')[-1] -eq $archiveName }
if (!$checksumLine -or (Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLower() -ne ($checksumLine -split '\s+')[0]) { throw 'Official Node archive checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $toolchains
if ((& $nodeExecutable --version) -ne "v$nodeVersion") { throw 'Installed project Node version mismatch.' }
Write-Output "Installed project Node v$nodeVersion."
