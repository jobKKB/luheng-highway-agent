param(
  [Parameter(Mandatory)][string]$Contract,
  [Parameter(Mandatory)][string]$JobRoot,
  [Parameter(Mandatory)][string]$Verifier
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Native Windows x64 required' }
New-Item -ItemType Directory -Force (Join-Path $JobRoot 'evidence') | Out-Null
& python -I -S -B $Verifier contract --contract $Contract --output (Join-Path $JobRoot 'evidence/contract-admission.json')
if ($LASTEXITCODE) { throw 'Unfilled or unreviewed qualification pins' }
$pins = Get-Content -LiteralPath $Contract -Raw | ConvertFrom-Json
$headers = @{ Authorization = "Bearer $env:READ_TOKEN"; Accept = 'application/vnd.github+json'; 'X-GitHub-Api-Version' = '2022-11-28' }
$run = Invoke-RestMethod -Uri "https://api.github.com/repos/$($pins.repository)/actions/runs/$($pins.build.runId)" -Headers $headers
if ($run.id -ne $pins.build.runId -or $run.head_sha -cne $pins.build.head -or $run.run_attempt -ne $pins.build.runAttempt -or $run.path -cne $pins.build.workflowPath -or $run.status -ne 'completed' -or $run.conclusion -ne 'success' -or $run.head_repository.full_name -cne $pins.repository) { throw 'Producer run is not the exact successful qualified build' }
$run | ConvertTo-Json -Depth 30 | Set-Content -Encoding utf8 (Join-Path $JobRoot 'evidence/producer-run-api.json')
foreach ($kind in @('portableArtifact', 'evidenceArtifact')) {
  $expected = $pins.$kind
  $actual = Invoke-RestMethod -Uri "https://api.github.com/repos/$($pins.repository)/actions/artifacts/$($expected.id)" -Headers $headers
  if ($actual.id -ne $expected.id -or $actual.name -cne $expected.name -or $actual.size_in_bytes -ne $expected.bytes -or $actual.digest -cne $expected.digest -or $actual.expired -or ([DateTimeOffset]$actual.expires_at) -le [DateTimeOffset]::UtcNow -or $actual.workflow_run.id -ne $pins.build.runId -or $actual.workflow_run.head_sha -cne $pins.build.head) { throw "Exact $kind API identity differs" }
  $actual | ConvertTo-Json -Depth 20 | Set-Content -Encoding utf8 (Join-Path $JobRoot "evidence/$kind-api.json")
}
$driveName = [IO.Path]::GetPathRoot([IO.Path]::GetFullPath($JobRoot)).TrimEnd('\').TrimEnd(':')
$drive = Get-PSDrive -Name $driveName
if ($drive.Free -lt [long]$pins.minimumScratchBytes) { throw 'Insufficient reviewed scratch budget; do not duplicate or partially expand the payload' }
Get-PSDrive -PSProvider FileSystem | Select-Object Name,Free | ConvertTo-Json | Set-Content -Encoding utf8 (Join-Path $JobRoot 'evidence/disk-before.json')
# One exact immutable artifact per native action. Names/pattern/latest are never selectors.
@(
  "portable-id=$($pins.portableArtifact.id)",
  "evidence-id=$($pins.evidenceArtifact.id)",
  "producer-run=$($pins.build.runId)",
  "producer-head=$($pins.build.head)"
) | Add-Content -LiteralPath $env:GITHUB_OUTPUT -Encoding utf8
Remove-Item Env:READ_TOKEN
