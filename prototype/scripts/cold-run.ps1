$ErrorActionPreference = 'Stop'
$sourceRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$runId = [guid]::NewGuid().ToString()
$targetRoot = Join-Path $sourceRoot ".local/cold-$runId"
$runner = Join-Path $targetRoot 'scripts/pnpm.ps1'
New-Item -ItemType Directory -Path $targetRoot | Out-Null
$roots = @('contracts','packages','scripts','tests','web','fixtures','acceptance','docs','config')
$files = @('package.json','pnpm-lock.yaml','pnpm-workspace.yaml','tsconfig.json','hardhat.config.ts','.node-version','.gitignore','README.md') | ForEach-Object { Get-Item -LiteralPath (Join-Path $sourceRoot $_) }
foreach ($folder in $roots) { $files += Get-ChildItem -LiteralPath (Join-Path $sourceRoot $folder) -File -Recurse }
$inventory = @()
foreach ($file in $files) {
  if ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Source link not permitted' }
  if ($file.Name -match '(?i)(private|secret|^\.env)' -or $file.Extension -in @('.sqlite','.db','.pem','.key')) { throw 'Private source file excluded; review source tree' }
  $relative = [IO.Path]::GetRelativePath($sourceRoot,$file.FullName)
  $destination = Join-Path $targetRoot $relative
  New-Item -ItemType Directory -Force -Path (Split-Path -Parent $destination) | Out-Null
  Copy-Item -LiteralPath $file.FullName -Destination $destination
  if (-not (Test-Path -LiteralPath $destination)) { throw 'Source copy missing' }
  # Source hashes identify the exact implementation under test, not a copy-integrity check.
  $inventory += @{path=$relative.Replace('\','/');sha256=(Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()}
}
$manifest = @{runId=$runId;kind='fresh-directory-local-verification';source=$sourceRoot;directory=$targetRoot;status='running';sources=$inventory;inheritedState=$false;steps=@();limits=@('Installs pinned project Node; reuses shared pnpm and compiler/package caches','No real model call or independent human adjudication','Not a production deployment or full AC acceptance')}
$manifestFile = Join-Path $targetRoot 'cold-run.json'
function Save-Run { $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestFile -Encoding utf8 }
Save-Run
Write-Output "Cold run directory: $targetRoot"
$savedEnv=@{}
foreach ($name in @('OPENAI_API_KEY','RPC_URL','CHAIN_ID')) { $savedEnv[$name]=[Environment]::GetEnvironmentVariable($name,'Process');Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue }
$env:RPC_URL='http://127.0.0.1:8545';$env:CHAIN_ID='31337'
Push-Location $targetRoot
try {
  & (Join-Path $targetRoot 'scripts/setup-node.ps1') *> (Join-Path $targetRoot 'setup-node.log')
  $setupCode=$LASTEXITCODE
  $manifest.steps += @{name='setup-node';exitCode=$setupCode;log='setup-node.log'};Save-Run
  if ($setupCode -ne 0) { throw 'Cold run pinned Node setup failed' }
  foreach ($step in @(@{name='install';arguments=@('install','--frozen-lockfile')},@{name='check-env';arguments=@('check:env')},@{name='verify';arguments=@('verify')})) {
    $log=Join-Path $targetRoot ($step.name+'.log')
    $stepArguments=$step.arguments
    & $runner @stepArguments *> $log
    $stepCode=$LASTEXITCODE
    $manifest.steps += @{name=$step.name;exitCode=$stepCode;log=$step.name+'.log'};Save-Run
    if ($stepCode -ne 0) { throw "Cold run step failed: $($step.name); see $log" }
    Write-Output "Cold run passed: $($step.name)"
  }
  $manifest.status='passed';Save-Run
} catch { $manifest.status='failed';Save-Run;throw }
finally { Pop-Location;foreach($name in $savedEnv.Keys){if($null -eq $savedEnv[$name]){Remove-Item -LiteralPath "Env:$name" -ErrorAction SilentlyContinue}else{[Environment]::SetEnvironmentVariable($name,$savedEnv[$name],'Process')}} }
Write-Output "Cold run manifest: $manifestFile"
