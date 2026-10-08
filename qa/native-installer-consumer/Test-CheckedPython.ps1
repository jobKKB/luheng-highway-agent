[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PythonExecutable,
    [Parameter(Mandatory)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'Invoke-CheckedPython.ps1')
if (Test-Path -LiteralPath $WorkRoot) { throw 'Fresh test directory required' }
New-Item -ItemType Directory -Path $WorkRoot | Out-Null
$probe = Join-Path $WorkRoot 'python process probe.py'
$env:LUHENG_PYTHON_PROBE_ID = 'inherited-nonsecret-test-value'
@'
import json, os, pathlib, sys, time
mode, output = sys.argv[1:]
assert os.environ['LUHENG_PYTHON_PROBE_ID'] == 'inherited-nonsecret-test-value'
if mode == 'timeout':
    time.sleep(20)
if mode == 'delayed':
    time.sleep(0.4)
if mode == 'verbose':
    sys.stdout.write('o' * 131072)
    sys.stderr.write('e' * 131072)
if mode != 'missing':
    pathlib.Path(output).write_text(json.dumps({'scope': 'probe', 'run': '123' if mode == 'type' else 123, 'verified': mode != 'identity'}), encoding='utf-8')
sys.exit(23 if mode == 'nonzero' else 0)
'@ | Set-Content -LiteralPath $probe -Encoding utf8NoBOM
$results = @()
foreach ($mode in @('delayed','verbose','nonzero','missing','identity','type','timeout','stale')) {
    $output = Join-Path $WorkRoot ($mode + ' result.json')
    if ($mode -eq 'stale') { '{}' | Set-Content -LiteralPath $output }
    $global:LASTEXITCODE = 0
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $failure = $null
    try {
        $null = Invoke-CheckedPython -PythonExecutable $PythonExecutable -ArgumentList @('-I','-S','-B',$probe,$mode,$output) -OutputPath $output -ExpectedFields @{scope='probe';run=[int64]123;verified=$true} -DiagnosticPrefix (Join-Path $WorkRoot $mode) -TimeoutSeconds $(if ($mode -eq 'timeout') { 1 } else { 10 })
    } catch { $failure = $_.Exception.Message }
    if ($mode -in @('delayed','verbose')) {
        if ($failure) { throw "$mode unexpectedly failed: $failure" }
        if ($mode -eq 'delayed' -and $watch.ElapsedMilliseconds -lt 400) { throw 'Python process was not awaited' }
    } else {
        $expected = @{nonzero='exit 23';missing='did not create';identity='identity differs';type='identity differs';timeout='timed out';stale='stale'}[$mode]
        if (-not $failure -or -not $failure.Contains($expected)) { throw "$mode did not reject correctly: $failure" }
    }
    if ($mode -eq 'timeout') {
        $record = Get-Content -LiteralPath (Join-Path $WorkRoot 'timeout.process.json') -Raw | ConvertFrom-Json
        if (Get-Process -Id $record.pid -ErrorAction SilentlyContinue) { throw 'Timed-out verifier is still running' }
    }
    $results += @{case=$mode;passed=$true;elapsedMs=$watch.ElapsedMilliseconds}
}
$results | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $WorkRoot 'results.json') -Encoding utf8NoBOM
$results | ConvertTo-Json
