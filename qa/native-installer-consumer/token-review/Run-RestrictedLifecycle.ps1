# Native restricted-token launcher; each caller must verify its own acceptance receipts.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$ProbeScript,
    [Parameter(Mandatory = $true)][string]$PowerShellExecutable,
    [string]$ProbeArgumentLine = '',
    [Parameter(Mandatory = $true)][string]$WorkingDirectory,
    [Parameter(Mandatory = $true)][string]$EvidencePath,
    [ValidateRange(1, 86400)][int]$TimeoutSeconds = 900,
    [hashtable]$ExtraEnvironment = @{},
    [switch]$ExecuteProbe
)
$ErrorActionPreference = 'Stop'
if (-not $ExecuteProbe) {
    throw 'Native execution requires an explicitly selected lifecycle probe and -ExecuteProbe.'
}
if ($env:OS -ne 'Windows_NT') { throw 'Native Windows is required; no emulation or OS mocking.' }
$probe = (Resolve-Path -LiteralPath $ProbeScript).Path
$work = (Resolve-Path -LiteralPath $WorkingDirectory).Path
if ($probe.Contains('"') -or $probe.Contains([char]0)) { throw 'Invalid probe path' }
if (-not [IO.Path]::IsPathRooted($PowerShellExecutable)) { throw 'Verified absolute PowerShell 7 executable path is required' }
$exe = (Resolve-Path -LiteralPath $PowerShellExecutable).Path
if (-not (Test-Path -LiteralPath $exe -PathType Leaf) -or [IO.Path]::GetFileName($exe) -ine 'pwsh.exe') { throw 'Verified installed PowerShell 7 pwsh.exe is required' }
Add-Type -Path (Join-Path $PSScriptRoot 'RestrictedTokenLauncher.cs')
# Only named ordinary environment values. Never copy the full Actions environment.
$environment = @{}
foreach ($name in @('SystemRoot', 'WINDIR', 'SystemDrive', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PATH', 'PATHEXT')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $environment[$name] = $value }
}
# Caller supplies only already-reviewed, non-secret lifecycle values such as isolated HERMES_HOME.
foreach ($name in $ExtraEnvironment.Keys) { $environment[$name] = [string]$ExtraEnvironment[$name] }
$pairs = @($environment.Keys | ForEach-Object { $_ + '=' + $environment[$_] })
# ProbeArgumentLine is an explicit Windows argument tail, not arbitrary -Command code.
# ProbeScript owns installation, app smoke, data-survival checks, and uninstall.
$arguments = '-NoLogo -NoProfile -NonInteractive -File "' + $probe + '" ' + $ProbeArgumentLine
$record = [ordered]@{
    schema = 'restricted-lifecycle-draft-v1'
    status = 'not-run'
    coverage = 'same-runner-user restricted-token lifecycle; separate standard account untested'
    executable = $exe
    probeScript = $probe
    timeoutSeconds = $TimeoutSeconds
    tokenEvidence = $null
    error = $null
    win32Error = $null
}
$success = $false
try {
    $result = [RestrictedTokenLauncher]::Run($exe, $arguments, $work, [string[]]$pairs, ($TimeoutSeconds * 1000))
    $record.tokenEvidence = $result
    $success = $result.TokenGatePassed -and $result.ProcessTreeFinished -and ($result.ExitCode -eq 0)
    $record.status = if ($success) { 'restricted-lifecycle-probe-exit-zero' } else { 'probe-failed' }
} catch {
    $record.status = 'helper-or-probe-blocked'
    $record.tokenEvidence = [RestrictedTokenLauncher]::LastEvidence
    $baseException = $_.Exception.GetBaseException()
    $record.error = $baseException.Message
    if ($baseException -is [ComponentModel.Win32Exception]) { $record.win32Error = $baseException.NativeErrorCode }
} finally {
    $record | ConvertTo-Json -Depth 16 | Set-Content -LiteralPath $EvidencePath -Encoding UTF8
}
if (-not $success) { throw ('Restricted lifecycle did not pass. Review evidence: ' + $EvidencePath) }
# Exit zero means only that the reviewed probe exited zero under the recorded child token.
# The consumer must verify its own stage receipts; token filtering does not validate assertions.
