# Self-report only: no product, registry, shell, or policy mutation.
[CmdletBinding()]
param(
    [Parameter(Mandatory)][string]$Helper,
    [Parameter(Mandatory)][string]$Output,
    [Parameter(Mandatory)][ValidateSet('direct','shell')][string]$Mode
)
$ErrorActionPreference='Stop'
try {
    Add-Type -Path $Helper
    $process=Get-Process -Id $PID
    $parent=(Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId
    $approvedEnvironment=@{}
    foreach($name in @('USERPROFILE','APPDATA','LOCALAPPDATA','TEMP')) {
        $approvedEnvironment[$name]=[Environment]::GetEnvironmentVariable($name,'Process')
    }
    $record=@{mode=$Mode;pid=$PID;parentPid=$parent;session=$process.SessionId;
        token=[RestrictedTokenLauncher]::InspectProcessToken($PID);
        environment=$approvedEnvironment;observedUtc=[DateTime]::UtcNow.ToString('o');error=$null}
    $record|ConvertTo-Json -Depth 16|Set-Content -LiteralPath $Output -Encoding utf8
} catch {
    @{mode=$Mode;pid=$PID;error=$_.Exception.Message}|ConvertTo-Json|Set-Content -LiteralPath $Output -Encoding utf8
    exit 1
}
