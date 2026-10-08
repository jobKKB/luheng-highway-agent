# Private artifact-consuming harness. Requires PowerShell 7 on native Windows.
[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string]$PackageRoot,
    [Parameter(Mandatory = $true)][string]$RuntimeManifest,
    [Parameter(Mandatory = $true)][string]$StateParent
)
$ErrorActionPreference = 'Stop'
if (-not $IsWindows) { throw 'Run on real Windows; OS simulation is forbidden' }
$package = (Resolve-Path -LiteralPath $PackageRoot).Path
$manifestPath = (Resolve-Path -LiteralPath $RuntimeManifest).Path
$parent = (Resolve-Path -LiteralPath $StateParent).Path
$manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
$python = Join-Path (Split-Path -Parent $manifestPath) $manifest.runtime.storePython
if (-not (Test-Path -LiteralPath $python -PathType Leaf)) { throw 'Manifest storePython is missing' }
# -I ignores inherited Python paths/user site; -S avoids any .pth startup code.
# The coordinator later rebases every profile path and passes a credential-free
# allow-listed environment to real shipped CLI executables and the tool worker.
& $python -I -S -B (Join-Path $PSScriptRoot 'windows_tool_contracts.py') `
    --package-root $package --runtime-manifest $manifestPath --state-parent $parent
if ($LASTEXITCODE -ne 0) { throw "Windows artifact contracts failed with exit code $LASTEXITCODE" }
