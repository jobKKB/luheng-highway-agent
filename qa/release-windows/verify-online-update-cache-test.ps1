$ErrorActionPreference='Stop'
$tokens=$null; $errors=$null
$ast=[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'verify-online-update.ps1'),[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Consumer syntax errors' }
foreach ($name in @('Hash','Assert-BaselineUpdaterCache')) {
    $function=$ast.Find({param($node) $node -is [Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -ceq $name},$true)
    if (-not $function) { throw "Missing function: $name" }
    . ([scriptblock]::Create($function.Extent.Text))
}
$root=Join-Path ([IO.Path]::GetTempPath()) ('luheng-cache-test-'+[guid]::NewGuid())
New-Item -ItemType Directory -Path $root | Out-Null
$file=Join-Path $root 'installer.exe'
[IO.File]::WriteAllText($file,'synthetic admitted baseline')
$bytes=(Get-Item $file).Length; $digest=Hash $file
Assert-BaselineUpdaterCache $root $bytes $digest
function Reject([scriptblock]$Action) { $rejected=$false; try { & $Action } catch { $rejected=$true }; if (-not $rejected) { throw 'Invalid cache accepted' } }
Reject { Assert-BaselineUpdaterCache $root ($bytes+1) $digest }
Reject { Assert-BaselineUpdaterCache $root $bytes ('0'*64) }
[IO.File]::WriteAllText((Join-Path $root 'pending.exe'),'unexpected target')
Reject { Assert-BaselineUpdaterCache $root $bytes $digest }
'Baseline cache positive, size, digest and extra-file checks passed'
