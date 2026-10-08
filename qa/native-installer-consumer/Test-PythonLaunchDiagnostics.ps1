[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$SelectedPython,
    [Parameter(Mandatory)][string]$ManagedPython,
    [Parameter(Mandatory)][string]$WorkRoot
)
$ErrorActionPreference = 'Stop'
if (Test-Path -LiteralPath $WorkRoot) { throw 'Fresh diagnostic scratch required' }
New-Item -ItemType Directory -Path $WorkRoot | Out-Null
Add-Type -Path (Join-Path $PSScriptRoot 'LifecycleProcessOwner.cs')
Add-Type -Path (Join-Path $PSScriptRoot 'token-review/RestrictedTokenLauncher.cs')
$tokenObjectDiagnostics = [RestrictedTokenLauncher]::ProbeCurrentObjectAccess()
$tokenObjectDiagnostics | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath (Join-Path $WorkRoot 'token-object-diagnostics.json') -Encoding utf8NoBOM
$probe = Join-Path $WorkRoot 'launch-probe.py'
@'
import json, os, pathlib, sys, time
time.sleep(0.3)
pathlib.Path(sys.argv[1]).write_text(json.dumps({'pid':os.getpid(),'executable':sys.executable,'baseExecutable':sys._base_executable,'version':sys.version,'completed':True}), encoding='utf-8')
print('PYTHON_LAUNCH_PROBE_COMPLETED', flush=True)
'@ | Set-Content -LiteralPath $probe -Encoding utf8NoBOM
$environment = @{}
foreach ($name in @('SystemRoot','WINDIR','SystemDrive','COMSPEC','TEMP','TMP','USERPROFILE','LOCALAPPDATA','APPDATA','PATH')) {
    $value = [Environment]::GetEnvironmentVariable($name, 'Process')
    if ($null -ne $value) { $environment[$name] = $value }
}
$pairs = [string[]]@($environment.Keys | ForEach-Object { $_ + '=' + $environment[$_] })
$rows = @()
$choices = @(@{name='selected';path=$SelectedPython},@{name='canonical-sibling';path=(Join-Path (Split-Path $SelectedPython) 'python.exe')},@{name='managed';path=$ManagedPython})
foreach ($choice in $choices) {
    $item = Get-Item -LiteralPath $choice.path -Force
    $identity = @{path=$item.FullName;attributes=[string]$item.Attributes;linkType=$item.LinkType;target=$item.Target;length=$item.Length;fileSddl=$null;parentSddl=$null;aclError=$null}
    try {
        $identity.fileSddl=(Get-Acl -LiteralPath $choice.path).Sddl
        $identity.parentSddl=(Get-Acl -LiteralPath (Split-Path $choice.path)).Sddl
    } catch { $identity.aclError=$_.Exception.ToString() }
    foreach ($method in @('dotnet-redirected','native-owner')) {
        $marker = Join-Path $WorkRoot ($choice.name + '-' + $method + '.json')
        $row = [ordered]@{choice=$choice.name;method=$method;file=$identity;stage='start';pid=$null;exitCode=$null;marker=$null;error=$null;fullException=$null;scriptStack=$null;win32Error=$null;nativeStart=$null;jobEmpty=$null;stdout=$null;stderr=$null}
        $process = $null; $owner = $null
        $timer = [Diagnostics.Stopwatch]::StartNew()
        try {
            if ($method -eq 'dotnet-redirected') {
                $start = [Diagnostics.ProcessStartInfo]::new()
                $start.FileName=$choice.path; $start.UseShellExecute=$false; $start.CreateNoWindow=$true
                $start.RedirectStandardOutput=$true; $start.RedirectStandardError=$true
                foreach ($argument in @('-I','-S','-B',$probe,$marker)) { $start.ArgumentList.Add($argument) }
                $row.stage='Process.Start'
                $process=[Diagnostics.Process]::Start($start)
                $row.pid=$process.Id
                $stdout=$process.StandardOutput.ReadToEndAsync(); $stderr=$process.StandardError.ReadToEndAsync()
                $row.stage='Process.WaitForExit'
                if (-not $process.WaitForExit(10000)) { $process.Kill($true); throw 'Probe timed out' }
                $row.exitCode=$process.ExitCode
                if (-not [Threading.Tasks.Task]::WhenAll([Threading.Tasks.Task[]]@($stdout,$stderr)).Wait(5000)) { throw 'Probe output did not close' }
                $row.stdout=$stdout.Result; $row.stderr=$stderr.Result
            } else {
                # Paths are explicit fixture inputs. No shell parses this argument tail.
                if ($probe.Contains('"') -or $marker.Contains('"')) { throw 'Unsafe diagnostic literal path' }
                $row.stage='StartSuspended'
                $owner=[LifecycleProcessOwner]::StartSuspended($choice.path,('-I -S -B "'+$probe+'" "'+$marker+'"'),(Get-Location).Path,$pairs)
                $row.pid=$owner.Process.Id
                $row.stage='Resume'
                $owner.Resume()
                $row.stage='NativeWaitForExit'
                if (-not $owner.Process.WaitForExit(10000)) { $owner.Terminate(); throw 'Native probe timed out' }
                $row.exitCode=$owner.Process.ExitCode
                $row.jobEmpty=$owner.WaitForEmpty(5000)
            }
            $row.stage='completed'
        } catch {
            $row.error=$_.Exception.Message
            $row.fullException=$_.Exception.ToString()
            $row.scriptStack=$_.ScriptStackTrace
            $base=$_.Exception.GetBaseException()
            if ($base -is [ComponentModel.Win32Exception]) { $row.win32Error=$base.NativeErrorCode }
        } finally {
            if ($method -eq 'native-owner') { $row.nativeStart=[LifecycleProcessOwner]::LastStartEvidence }
            if ($null -ne $owner) { $owner.Dispose() }
            if ($null -ne $process) { $process.Dispose() }
            # A failed managed start could still have created a finite child; observe its marker.
            Start-Sleep -Milliseconds 500
            if (Test-Path -LiteralPath $marker) { $row.marker=Get-Content -LiteralPath $marker -Raw|ConvertFrom-Json }
            $row.elapsedMs=$timer.ElapsedMilliseconds
            $rows += $row
            @{schema=1;diagnosticOnly=$true;token=[RestrictedTokenLauncher]::InspectProcessToken($PID);tokenObjectDiagnostics=$tokenObjectDiagnostics;results=$rows} | ConvertTo-Json -Depth 18 | Set-Content -LiteralPath (Join-Path $WorkRoot 'launch-diagnostics.json') -Encoding utf8NoBOM
        }
    }
}
$rows | ForEach-Object { [pscustomobject]$_ } | Select-Object choice,method,stage,exitCode,win32Error,error | Format-Table -AutoSize
