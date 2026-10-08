[CmdletBinding()]
param(
  [Parameter(Mandatory)][string]$ReplayContract,
  [Parameter(Mandatory)][string]$ConsumerDirectory,
  [Parameter(Mandatory)][string]$JobRoot
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Native Windows x64 required' }
if (-not $env:RUNNER_TEMP -or $env:GITHUB_ACTIONS -cne 'true') { throw 'Disposable Actions runner required' }
$job = [IO.Path]::GetFullPath($JobRoot)
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $job.StartsWith($runner,[StringComparison]::OrdinalIgnoreCase)) { throw 'Replay root outside disposable scratch' }
$evidence = Join-Path $job 'evidence'
New-Item -ItemType Directory -Force $evidence | Out-Null
$verify = Join-Path $PSScriptRoot 'verify_replay.py'
$contract = Join-Path $ConsumerDirectory 'contract.json'
& python -I -S -B $verify contract --consumer $ConsumerDirectory --contract $ReplayContract --source-contract $contract --output (Join-Path $evidence 'replay-contract-admission.json')
if ($LASTEXITCODE) { throw 'Frozen replay contract is not admitted' }
$pins = Get-Content -LiteralPath $ReplayContract -Raw | ConvertFrom-Json
$source = Get-Content -LiteralPath $contract -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $env:READ_TOKEN"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
try {
  $base = "https://api.github.com/repos/$($pins.repository)/actions"
  $requests = [ordered]@{
    'builder-run-api.json' = "$base/runs/$($pins.builder.runId)"
    'source-run-api.json' = "$base/runs/$($source.build.runId)"
    'builder-jobs-api.json' = "$base/runs/$($pins.builder.runId)/attempts/$($pins.builder.runAttempt)/jobs?per_page=100"
    'candidate-artifact-api.json' = "$base/artifacts/$($pins.candidateArtifact.id)"
    'builder-evidence-artifact-api.json' = "$base/artifacts/$($pins.builderEvidenceArtifact.id)"
    'source-evidence-artifact-api.json' = "$base/artifacts/$($source.evidenceArtifact.id)"
  }
  foreach ($name in $requests.Keys) {
    $response = Invoke-RestMethod -Uri $requests[$name] -Headers $headers
    $response | ConvertTo-Json -Depth 60 | Set-Content -LiteralPath (Join-Path $evidence $name) -Encoding utf8
  }
} finally {
  Remove-Item Env:READ_TOKEN -ErrorAction SilentlyContinue
  $headers.Clear()
}
& python -I -S -B $verify api --consumer $ConsumerDirectory --contract $ReplayContract --source-contract $contract --api-root $evidence --output (Join-Path $evidence 'replay-api-admission.json')
if ($LASTEXITCODE) { throw 'Exact run/step/artifact API admission failed' }
$driveName = [IO.Path]::GetPathRoot($job).TrimEnd('\').TrimEnd(':')
$drive = Get-PSDrive -Name $driveName
@{ free_bytes=[long]$drive.Free; minimum_scratch_bytes=[long]$pins.minimumScratchBytes; basis=$pins.scratchBudgetBasis; drive=$driveName } | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $evidence 'replay-disk-before.json') -Encoding utf8
if ($drive.Free -lt [long]$pins.minimumScratchBytes) { throw 'Insufficient measured two-copy native replay scratch reservation' }
Copy-Item -LiteralPath $ReplayContract -Destination (Join-Path $evidence 'replay-contract.original.json')
Copy-Item -LiteralPath $contract -Destination (Join-Path $evidence 'consumer-contract.original.json')
@(
  "candidate-id=$($pins.candidateArtifact.id)",
  "builder-evidence-id=$($pins.builderEvidenceArtifact.id)",
  "builder-run=$($pins.builder.runId)",
  "source-evidence-id=$($source.evidenceArtifact.id)",
  "source-run=$($source.build.runId)"
) | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
