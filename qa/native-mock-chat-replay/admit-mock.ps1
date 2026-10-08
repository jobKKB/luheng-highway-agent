[CmdletBinding()]
param([Parameter(Mandatory)][string]$Contract,[Parameter(Mandatory)][string]$JobRoot)
$ErrorActionPreference='Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted' -or -not $env:RUNNER_TEMP) { throw 'Disposable hosted native Actions runner required' }
$job=[IO.Path]::GetFullPath($JobRoot)
$runner=[IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\')+'\'
if (-not $job.StartsWith($runner,[StringComparison]::OrdinalIgnoreCase)) { throw 'Mock replay root outside disposable scratch' }
$out=Join-Path $job 'evidence'
New-Item -ItemType Directory -Force $out | Out-Null
$verify=Join-Path $PSScriptRoot 'admission/verify_mock.py'
& python -I -S -B $verify contract --contract $Contract --output (Join-Path $out 'contract-admission.json')
if ($LASTEXITCODE) { throw 'Exact 0.7.1 mock replay contract refused' }
$pins=Get-Content -LiteralPath $Contract -Raw | ConvertFrom-Json
$headers=@{Authorization="Bearer $env:READ_TOKEN";Accept='application/vnd.github+json';'X-GitHub-Api-Version'='2022-11-28'}
try {
  $base='https://api.github.com/repos/jobKKB/luheng-highway-agent'
  $requests=[ordered]@{
    'producer-run.json'="$base/actions/runs/$($pins.build.runId)"
    'evidence-artifact.json'="$base/actions/artifacts/$($pins.evidenceArtifact.id)"
    'release.json'="$base/releases/tags/v0.7.1-beta.1"
  }
  foreach ($name in $requests.Keys) {
    $value=Invoke-RestMethod -Uri $requests[$name] -Headers $headers
    $value | ConvertTo-Json -Depth 90 | Set-Content -LiteralPath (Join-Path $out $name) -Encoding utf8
  }
} finally { Remove-Item Env:READ_TOKEN -ErrorAction SilentlyContinue; $headers.Clear() }
& python -I -S -B $verify api --contract $Contract --api-root $out --output (Join-Path $out 'api-admission.json')
if ($LASTEXITCODE) { throw 'Producer, evidence or published exact asset identity differs' }
$minimum=[long]$pins.minimumScratchBytes
if ($minimum -lt (2*[long]6470743229+[long]1593299205+[long]5808718+4GB)) { throw 'Scratch contract is insufficient' }
$drive=Get-PSDrive -Name ([IO.Path]::GetPathRoot($job).TrimEnd('\').TrimEnd(':'))
@{free_bytes=[long]$drive.Free;minimum_scratch_bytes=$minimum} | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $out 'disk-before.json') -Encoding utf8
if ($drive.Free -lt $minimum) { throw 'Insufficient scratch for installed and NSIS extraction copies' }
Copy-Item -LiteralPath $Contract -Destination (Join-Path $out 'mock-contract.original.json')
@("evidence-id=$($pins.evidenceArtifact.id)","producer-run=$($pins.build.runId)") | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
