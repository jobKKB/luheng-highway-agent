# Consumer-only native A/B acceptance. Run through the existing restricted-token launcher.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$PairLock,
    [Parameter(Mandatory)][string]$JobRoot,
    [Parameter(Mandatory)][string]$NodeExecutable,
    [Parameter(Mandatory)][string]$DependencyPackage,
    [Parameter(Mandatory)][string]$PythonExecutable
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows -or $env:GITHUB_ACTIONS -cne 'true' -or $env:RUNNER_ENVIRONMENT -cne 'github-hosted') {
    throw 'Disposable native GitHub-hosted Windows consumer required'
}
if ([Runtime.InteropServices.RuntimeInformation]::OSArchitecture -ne 'X64') { throw 'Native Windows x64 required' }
if (-not [Environment]::UserInteractive) { throw 'An interactive native desktop is required for the real NSIS wizard' }
$job = [IO.Path]::GetFullPath($JobRoot)
$runner = [IO.Path]::GetFullPath($env:RUNNER_TEMP).TrimEnd('\') + '\'
if (-not $job.StartsWith($runner, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $job)) {
    throw 'A fresh job directory below RUNNER_TEMP is required'
}
$node = (Resolve-Path -LiteralPath $NodeExecutable).Path
$dependency = (Resolve-Path -LiteralPath $DependencyPackage).Path
$python = (Resolve-Path -LiteralPath $PythonExecutable).Path
. (Join-Path $PSScriptRoot '../native-installer-consumer/Invoke-CheckedPython.ps1')
$pair = Get-Content -LiteralPath $PairLock -Raw | ConvertFrom-Json
Add-Type -Path (Join-Path $PSScriptRoot '../native-installer-consumer/token-review/RestrictedTokenLauncher.cs')
$token = [RestrictedTokenLauncher]::InspectProcessToken($PID)
if ($token.IsElevated -ne 0 -or $token.IntegritySid -cne 'S-1-16-8192') { throw 'Medium-integrity non-elevated token required' }
New-Item -ItemType Directory -Path $job | Out-Null
$state = Join-Path $job 'state'
$out = Join-Path $job 'evidence'
$install = Join-Path $job 'install'
$profileHome=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) 'luheng-agent'
$profileUserData=Join-Path ([Environment]::GetFolderPath('ApplicationData')) 'luheng-agent-desktop'
foreach ($profile in @($profileHome,$profileUserData)) {
    if (Test-Path -LiteralPath $profile) { throw 'Product default profile already exists; refusing to touch it' }
}
foreach ($folder in @($state,$out,$profileHome,$profileUserData,(Join-Path $state 'project'),(Join-Path $state 'temp'))) {
    New-Item -ItemType Directory -Force -Path $folder | Out-Null
}
$exe = Join-Path $install 'LuhengOfficeAgent.exe'
$runtime = @{ pair=$pair; job=$job; exe=$exe; state=$state; home=$profileHome; userData=$profileUserData; profileMode='fresh-disposable-default'; project=(Join-Path $state 'project'); evidence=$out }
$runtimePath = Join-Path $job 'runtime.json'
$runtime | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $runtimePath -Encoding utf8NoBOM
# Explorer launches the post-NSIS process with the ordinary user environment.
# Use only fresh official default directories on this disposable hosted runner.
foreach ($name in @('HERMES_HOME','HERMES_DESKTOP_USER_DATA_DIR','HERMES_DATA_DIR_SUFFIX')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
$env:TEMP = Join-Path $state 'temp'
$env:TMP = $env:TEMP
$env:HERMES_DISABLE_LAZY_INSTALLS = '1'
$env:PYTHONDONTWRITEBYTECODE = '1'
foreach ($name in @('ELECTRON_RUN_AS_NODE','NODE_OPTIONS','NODE_PATH','ELECTRON_DISABLE_SANDBOX')) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
@{ lsp=@{enabled=$false}; plugins=@{enabled=@()}; updates=@{check=$false}; security=@{allow_lazy_installs=$false}; telemetry=@{shared_metrics=@{enabled=$false;send_enabled=$false}} } |
    ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $runtime.home 'config.yaml') -Encoding utf8NoBOM
$report = [ordered]@{ schema=1; status='failed'; pair=$pair; token=$token; automaticUpdateVerified=$false; baselineInstalled=$false; baselineTreeVerified=$false; targetTreeVerified=$false; productConsentConfirmed=$false; installerWizardCompleted=$false; targetAutomaticallyRelaunched=$false; targetFixtureOpened=$false; targetAutomaticProfileVerified=$false; targetDataVerified=$false; forcedCleanup=$false; uiActions=@(); error=$null }
$owned = [Collections.Generic.List[Diagnostics.Process]]::new()
function Hash([string]$File) { (Get-FileHash -LiteralPath $File -Algorithm SHA256).Hash.ToLowerInvariant() }
function Assert-BaselineUpdaterCache([string]$Directory,[long]$Bytes,[string]$Sha256) {
    $root=Get-Item -LiteralPath $Directory
    $files=@(Get-ChildItem -LiteralPath $Directory -Force)
    if (-not $root.PSIsContainer -or ($root.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $files.Count -ne 1) { throw 'Unexpected baseline updater cache contents' }
    $file=$files[0]
    # NSIS intentionally caches its own installer; no target or pending download is allowed.
    if ($file.Name -cne 'installer.exe' -or $file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or
        $file.Length -ne $Bytes -or (Hash $file.FullName) -cne $Sha256) { throw 'Baseline updater cache does not match the admitted installer' }
}
function Assert-InstalledTree([string]$Side,[string]$OutputName) {
    $entry = $pair.$Side
    if ((Hash $entry.structurePath) -cne $entry.evidence.files.structure.sha256) { throw 'Installed-tree manifest pin differs' }
    $structure = Get-Content -LiteralPath $entry.structurePath -Raw | ConvertFrom-Json
    $outputPath = Join-Path $out ($OutputName + '.json')
    Invoke-CheckedPython -PythonExecutable $python -ArgumentList @('-I','-S','-B',(Join-Path $PSScriptRoot 'verify-online-update.py'),'tree','--pair',$PairLock,'--side',$Side,'--root',$install,'--output',$outputPath) -OutputPath $outputPath -ExpectedFields @{exact_membership=$true;every_payload_file_sha256_verified=$true;source_commit=$structure.source_commit;source_tree_sha256=$structure.source_tree_sha256;rebuilt=$false} -TimeoutSeconds 900 -DiagnosticPrefix (Join-Path $out ($OutputName + '-python')) | Out-Null
}
function Start-Owned([string]$File,[string[]]$Arguments) {
    $start = [Diagnostics.ProcessStartInfo]::new()
    $start.FileName=$File; $start.UseShellExecute=$false; $start.WorkingDirectory=$job
    foreach ($argument in $Arguments) { $start.ArgumentList.Add($argument) }
    $process=[Diagnostics.Process]::Start($start); $owned.Add($process); return $process
}
function Wait-Success([Diagnostics.Process]$Process,[int]$Seconds) {
    if (-not $Process.WaitForExit($Seconds*1000)) { throw 'Owned process timed out' }
    if ($Process.ExitCode -ne 0) { throw "Owned process failed with exit $($Process.ExitCode)" }
}
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
Add-Type -Path (Join-Path $PSScriptRoot 'verify-online-update.cs')
function Windows-For([int]$ProcessId) {
    $condition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ProcessIdProperty,$ProcessId)
    return [Windows.Automation.AutomationElement]::RootElement.FindAll([Windows.Automation.TreeScope]::Children,$condition)
}
function Click-Button($Window,[string[]]$Names) {
    $buttons=$Window.FindAll([Windows.Automation.TreeScope]::Descendants,[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty,[Windows.Automation.ControlType]::Button))
    foreach ($button in $buttons) {
        if ($button.Current.IsEnabled -and -not $button.Current.IsOffscreen -and $button.Current.Name -cin $Names) {
            $invoke=$button.GetCurrentPattern([Windows.Automation.InvokePattern]::Pattern)
            $report.uiActions += @{pid=$Window.Current.ProcessId; window=$Window.Current.Name; button=$button.Current.Name}
            $invoke.Invoke(); return $true
        }
    }
    return $false
}
function Test-FixtureCandidate([int]$WindowPid,[int]$ExpectedPid,[string]$Name,[string]$Marker,[bool]$Enabled,[bool]$Offscreen) {
    return $WindowPid -gt 0 -and $WindowPid -eq $ExpectedPid -and $Name -ceq $Marker -and
        $Marker -cmatch '^online-update-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$' -and $Enabled -and -not $Offscreen
}
function Open-RetainedFixture([int]$ExpectedPid,[string]$Marker) {
    $nameCondition=[Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::NameProperty,$Marker)
    foreach ($window in (Windows-For $ExpectedPid)) {
        foreach ($element in $window.FindAll([Windows.Automation.TreeScope]::Descendants,$nameCondition)) {
            if (-not (Test-FixtureCandidate $window.Current.ProcessId $ExpectedPid $element.Current.Name $Marker $element.Current.IsEnabled $element.Current.IsOffscreen)) { continue }
            # Invoking the actual row drives ordinary session.resume; the launch
            # profile then keeps its real shared SessionDB open for ownership proof.
            $pattern=$null
            if ($element.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern,[ref]$pattern)) {
                $pattern.Invoke(); $method='Invoke'
            } elseif ($element.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern,[ref]$pattern)) {
                $pattern.Select(); $method='Select'
            } else { continue }
            $report.uiActions += @{pid=$ExpectedPid; window=$window.Current.Name; fixture=$Marker; pattern=$method}
            return $true
        }
    }
    return $false
}
try {
    $testMarker='online-update-12345678-1234-1234-1234-123456789abc'
    if (-not (Test-FixtureCandidate 123 123 $testMarker $testMarker $true $false)) { throw 'Fixture selector positive self-test failed' }
    if ((Test-FixtureCandidate 124 123 $testMarker $testMarker $true $false) -or
        (Test-FixtureCandidate 123 123 ($testMarker+'suffix') $testMarker $true $false) -or
        (Test-FixtureCandidate 123 123 $testMarker $testMarker $false $false) -or
        (Test-FixtureCandidate 123 123 $testMarker $testMarker $true $true) -or
        (Test-FixtureCandidate 123 123 'arbitrary' 'arbitrary' $true $false)) { throw 'Fixture selector boundary self-test failed' }
    & $node (Join-Path $PSScriptRoot 'verify-online-update.mjs') --self-test
    if ($LASTEXITCODE) { throw 'Consumer invariant self-test failed' }
    & $node (Join-Path $PSScriptRoot 'verify-online-update.mjs') --validate-pair $PairLock
    if ($LASTEXITCODE) { throw 'Pair authority or exact artifact fields are invalid' }
    if ($pair.schema -cne 'luheng-online-update/v1' -or $pair.repository -cne 'jobKKB/luheng-highway-agent' -or $pair.from.version -cne '0.7.0' -or $pair.to.version -cne '0.7.1') { throw 'Unexpected version pair' }
    $baseline=(Resolve-Path -LiteralPath $pair.from.path).Path
    $item=Get-Item -LiteralPath $baseline
    if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint -or $item.Length -ne $pair.from.bytes -or (Hash $baseline) -cne $pair.from.sha256) { throw 'Baseline installer custody mismatch' }
    $baselineStructure=Get-Content -LiteralPath $pair.from.structurePath -Raw | ConvertFrom-Json
    $cacheName=$baselineStructure.update_configuration.updaterCacheDirName
    if ($cacheName -cnotmatch '^[A-Za-z0-9_-]+$') { throw 'Unsafe admitted updater cache directory' }
    $cache=Join-Path ([Environment]::GetFolderPath('LocalApplicationData')) $cacheName
    if (Test-Path -LiteralPath $cache) { throw 'Updater cache existed before baseline installation; refusing to reuse it' }
    $baselineProcess=Start-Owned $baseline @('/S','/currentuser',"/D=$install")
    Wait-Success $baselineProcess 900
    if ((Hash $exe) -cne $pair.from.exeSha256 -or (Hash (Join-Path $install 'resources/app.asar')) -cne $pair.from.asarSha256) { throw 'Installed baseline payload mismatch' }
    Assert-InstalledTree 'from' 'baseline-tree'
    $report.baselineTreeVerified=$true
    $configuration=Get-Content -LiteralPath (Join-Path $install 'resources/app-update.yml') -Raw
    $cacheMatch=[regex]::Match($configuration,'(?m)^updaterCacheDirName:\s*([A-Za-z0-9_-]+)\s*$')
    if (-not $cacheMatch.Success -or $cacheMatch.Groups[1].Value -cne $cacheName) { throw 'Immutable updater cache differs from the admitted configuration' }
    Assert-BaselineUpdaterCache $cache $pair.from.bytes $pair.from.sha256
    $report.baselineInstalled=$true
    $driver=Start-Owned $node @((Join-Path $PSScriptRoot 'verify-online-update.mjs'),'handoff',$runtimePath,$dependency)
    $deadline=[DateTime]::UtcNow.AddMinutes(35)
    $ready=$null; $installerPids=@{}; $checkedFiles=@{}; $restarted=$null
    while ([DateTime]::UtcNow -lt $deadline) {
        if (-not $ready -and (Test-Path -LiteralPath (Join-Path $out 'baseline-ready.json'))) {
            $ready=Get-Content -LiteralPath (Join-Path $out 'baseline-ready.json') -Raw | ConvertFrom-Json
            $process=Get-Process -Id $ready.pid -ErrorAction Stop
            if ($process.Path -ine $exe -or (Hash $process.Path) -cne $pair.from.exeSha256) { throw 'Baseline UI ownership mismatch' }
        }
        if ($ready -and -not $report.productConsentConfirmed) {
            foreach ($window in (Windows-For $ready.pid)) {
                if ($window.Current.Name -ceq 'Install preview update' -and (Click-Button $window @('Install update'))) {
                    $report.productConsentConfirmed=$true
                }
            }
        }
        # Only the exact product-downloaded B bytes can authorize NSIS UI interaction.
        if ($report.productConsentConfirmed) {
            foreach ($process in @(Get-CimInstance Win32_Process)) {
                $file=[string]$process.ExecutablePath
                if (-not $file -or (-not $file.StartsWith($job+'\',[StringComparison]::OrdinalIgnoreCase) -and -not $file.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase))) { continue }
                if (-not $checkedFiles.ContainsKey($file) -and (Test-Path -LiteralPath $file -PathType Leaf)) {
                    $candidate=Get-Item -LiteralPath $file
                    if ($candidate.Length -eq $pair.to.bytes) { $checkedFiles[$file]=((Hash $file) -ceq $pair.to.sha256) }
                }
                if ($checkedFiles[$file] -eq $true) {
                    $installerToken=[RestrictedTokenLauncher]::InspectProcessToken([int]$process.ProcessId)
                    if ($installerToken.UserSid -cne $token.UserSid -or $installerToken.IsElevated -ne 0 -or $installerToken.IntegritySid -cne 'S-1-16-8192') { throw 'Installer changed user or elevated' }
                    $installerPids[[int]$process.ProcessId]=$file
                    foreach ($window in (Windows-For ([int]$process.ProcessId))) {
                        if (Click-Button $window @('Finish','&Finish','完成','完成(&F)')) { $report.installerWizardCompleted=$true }
                        else { [void](Click-Button $window @('Next >','&Next >','Install','&Install','下一步(&N) >','安装(&I)','下一步 >','安装')) }
                    }
                }
            }
        }
        if ($ready -and $report.installerWizardCompleted) {
            foreach ($process in @(Get-Process -Name 'LuhengOfficeAgent' -ErrorAction SilentlyContinue)) {
                if ($process.Id -ne $ready.pid -and $process.Path -ieq $exe -and $process.MainWindowHandle -ne 0) {
                    if ((Hash $exe) -cne $pair.to.exeSha256 -or (Hash (Join-Path $install 'resources/app.asar')) -cne $pair.to.asarSha256) { throw 'Relaunched target payload differs' }
                    $childToken=[RestrictedTokenLauncher]::InspectProcessToken($process.Id)
                    if ($childToken.UserSid -cne $token.UserSid -or $childToken.IsElevated -ne 0 -or $childToken.IntegritySid -cne 'S-1-16-8192') { throw 'Target restart changed user or elevated' }
                    $restarted=$process; $report.targetAutomaticallyRelaunched=$true
                    $report.relaunch=@{pid=$process.Id; exe=$process.Path; token=$childToken; observedUtc=[DateTime]::UtcNow.ToString('o')}
                    break
                }
            }
        }
        $driver.Refresh()
        if ($driver.HasExited -and $driver.ExitCode -ne 0) { throw 'Renderer handoff consumer failed; inspect its receipt' }
        if ($restarted) { break }
        Start-Sleep -Milliseconds 400
    }
    if (-not $restarted) { throw 'Target was not automatically relaunched after the real NSIS wizard' }
    Wait-Success $driver 30
    foreach ($processId in $installerPids.Keys) {
        $process=Get-Process -Id $processId -ErrorAction SilentlyContinue
        if ($process -and -not $process.WaitForExit(60000)) { throw 'Owned updater installer remained running' }
    }
    $fixture=Get-Content -LiteralPath (Join-Path $out 'fixture.json') -Raw | ConvertFrom-Json
    $fixtureDeadline=[DateTime]::UtcNow.AddSeconds(120)
    do {
        if (Open-RetainedFixture $restarted.Id $fixture.marker) { $report.targetFixtureOpened=$true; break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $fixtureDeadline)
    if (-not $report.targetFixtureOpened) { throw 'Automatic target did not expose the exact retained session as an enabled actionable UI element' }
    # The product's ordinary ownership record identifies the automatic restart, while
    # Windows file ownership proves that backend opened the original HOME database.
    $profileDeadline=[DateTime]::UtcNow.AddSeconds(120)
    $ownershipFile=Join-Path $runtime.userData 'backend-ownership.json'
    $database=Join-Path $runtime.home 'state.db'
    while ([DateTime]::UtcNow -lt $profileDeadline) {
        if ((Test-Path -LiteralPath $ownershipFile) -and (Test-Path -LiteralPath $database)) {
            $ownership=Get-Content -LiteralPath $ownershipFile -Raw | ConvertFrom-Json
            foreach ($entry in @($ownership.backends | Where-Object { $_.parentPid -eq $restarted.Id })) {
                $backend=Get-CimInstance Win32_Process -Filter "ProcessId=$($entry.pid)"
                if ($backend -and $backend.ExecutablePath.StartsWith($install+'\',[StringComparison]::OrdinalIgnoreCase) -and
                    [OnlineUpdateFileOwners]::ForFile($database) -contains [int]$entry.pid) {
                    $report.targetAutomaticProfileVerified=$true
                    $report.automaticProfile=@{parentPid=$restarted.Id; backendPid=[int]$entry.pid; userData=$runtime.userData; database=$database; method='product-ownership-and-Windows-file-owner'}
                    break
                }
            }
        }
        if ($report.targetAutomaticProfileVerified) { break }
        Start-Sleep -Milliseconds 500
    }
    if (-not $report.targetAutomaticProfileVerified) { throw 'Automatic target did not prove original userData and HOME database ownership' }
    if (-not $restarted.CloseMainWindow() -or -not $restarted.WaitForExit(60000)) { throw 'Automatically relaunched target did not close normally' }
    $verify=Start-Owned $node @((Join-Path $PSScriptRoot 'verify-online-update.mjs'),'verify',$runtimePath,$dependency)
    Wait-Success $verify 180
    $verified=Get-Content -LiteralPath (Join-Path $out 'renderer-verify.json') -Raw | ConvertFrom-Json
    if ($verified.status -cne 'target-and-data-verified' -or $verified.settingsSessionAndFileRetained -ne $true) { throw 'Target data verification incomplete' }
    Assert-InstalledTree 'to' 'target-tree'
    $report.targetTreeVerified=$true
    $report.targetDataVerified=$true; $report.automaticUpdateVerified=$true; $report.status='online-update-verified'
} catch {
    $report.error=$_.Exception.Message
    $report.errorLocation=$_.InvocationInfo.PositionMessage
    $report.errorStack=$_.ScriptStackTrace
    $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $out 'online-update.json') -Encoding utf8NoBOM
} finally {
    foreach ($process in $owned) {
        if (-not $process.HasExited) {
            $report.forcedCleanup=$true
            try { $process.Kill($true); [void]$process.WaitForExit(10000) }
            catch { $report.cleanupError=$_.Exception.Message }
        }
    }
    $cleanupDeadline=[DateTime]::UtcNow.AddSeconds(20)
    do {
        $remaining=@(Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and ($_.ExecutablePath.StartsWith($job+'\',[StringComparison]::OrdinalIgnoreCase) -or ($cache -and $_.ExecutablePath.StartsWith($cache+'\',[StringComparison]::OrdinalIgnoreCase))) })
        if (-not $remaining.Count) { break }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $cleanupDeadline)
    foreach ($process in $remaining) {
        $report.forcedCleanup=$true
        Stop-Process -Id $process.ProcessId -Force -ErrorAction SilentlyContinue
    }
    if ($report.forcedCleanup) { $report.status='failed'; $report.automaticUpdateVerified=$false }
    $report | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath (Join-Path $out 'online-update.json') -Encoding utf8NoBOM
}
if (-not $report.automaticUpdateVerified) { throw ('Online update acceptance failed: '+$report.error) }
