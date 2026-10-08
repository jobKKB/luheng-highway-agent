# Dot-source this helper so restricted and ordinary consumers use the same wait contract.
function Invoke-CheckedPython {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory)][string]$PythonExecutable,
        [Parameter(Mandatory)][string[]]$ArgumentList,
        [Parameter(Mandatory)][string]$OutputPath,
        [Parameter(Mandatory)][hashtable]$ExpectedFields,
        [Parameter(Mandatory)][string]$DiagnosticPrefix,
        [ValidateRange(1, 3600)][int]$TimeoutSeconds = 900
    )
    $ErrorActionPreference = 'Stop'
    if (-not [IO.Path]::IsPathFullyQualified($PythonExecutable) -or -not (Test-Path -LiteralPath $PythonExecutable -PathType Leaf)) {
        throw 'An existing absolute Python executable is required'
    }
    if (Test-Path -LiteralPath $OutputPath) { throw 'Refusing a stale Python verification report' }
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName = $PythonExecutable
    $start.UseShellExecute = $false
    $start.CreateNoWindow = $true
    $start.RedirectStandardOutput = $true
    $start.RedirectStandardError = $true
    foreach ($argument in $ArgumentList) { $start.ArgumentList.Add($argument) }
    # Inherit the caller token and environment, including the real acceptance run identity.
    # Retaining Process.Start's handle avoids PowerShell GUI classification/backgrounding
    # and makes success independent of the ambient LASTEXITCODE variable.
    $process = $null
    $stdoutTask = $null
    $stderrTask = $null
    $clock = [Diagnostics.Stopwatch]::StartNew()
    $record = [ordered]@{ executable=$PythonExecutable; pid=$null; exitCode=$null; timedOut=$false; elapsedMs=0; outputPath=$OutputPath; reportVerified=$false; error=$null }
    try {
        $process = [Diagnostics.Process]::Start($start)
        $record.pid = $process.Id
        # Drain both pipes concurrently so verbose failures cannot deadlock the verifier.
        $stdoutTask = $process.StandardOutput.ReadToEndAsync()
        $stderrTask = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $record.timedOut = $true
            $process.Kill($true)
            if (-not $process.WaitForExit(10000)) { throw 'Timed-out Python verification process did not exit after termination' }
            throw 'Python verification timed out'
        }
        $record.exitCode = $process.ExitCode
        if (-not [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdoutTask,$stderrTask)).Wait(5000)) {
            throw 'Python verification output streams did not close'
        }
        if ($process.ExitCode -ne 0) { throw "Python verification failed with exit $($process.ExitCode)" }
        if (-not (Test-Path -LiteralPath $OutputPath -PathType Leaf)) { throw 'Python verification did not create its report' }
        $item = Get-Item -LiteralPath $OutputPath
        if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Python verification report is a link' }
        $result = Get-Content -LiteralPath $OutputPath -Raw | ConvertFrom-Json -ErrorAction Stop
        foreach ($name in $ExpectedFields.Keys) {
            $property = $result.PSObject.Properties[$name]
            # JSON serialization distinguishes booleans/numbers/strings without coercion.
            if ($null -eq $property -or
                (ConvertTo-Json -InputObject $property.Value -Compress -Depth 10) -cne
                (ConvertTo-Json -InputObject $ExpectedFields[$name] -Compress -Depth 10)) {
                throw "Python verification report identity differs: $name"
            }
        }
        $record.reportVerified = $true
        return $result
    } catch {
        $record.error = $_.Exception.Message
        throw
    } finally {
        $record.elapsedMs = $clock.ElapsedMilliseconds
        foreach ($stream in @(@{task=$stdoutTask; suffix='stdout'},@{task=$stderrTask; suffix='stderr'})) {
            $value = if ($null -ne $stream.task -and $stream.task.IsCompletedSuccessfully) { $stream.task.Result } else { '[Output stream unavailable or incomplete]' }
            [IO.File]::WriteAllText(($DiagnosticPrefix + '.' + $stream.suffix + '.txt'), $value)
        }
        $record | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath ($DiagnosticPrefix + '.process.json') -Encoding utf8NoBOM
        if ($null -ne $process) { $process.Dispose() }
    }
}
