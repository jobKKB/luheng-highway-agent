[CmdletBinding()]
param([Parameter(Mandatory)][string]$LifecycleScript,[Parameter(Mandatory)][string]$OutputFile)
$ErrorActionPreference='Stop'
if (-not $IsWindows) { throw 'Native Windows required' }
$tokens=$null; $errors=$null
$ast=[System.Management.Automation.Language.Parser]::ParseFile((Resolve-Path -LiteralPath $LifecycleScript).Path,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw 'Lifecycle PowerShell parsing failed' }
$functions=@($ast.FindAll({param($node) $node -is [System.Management.Automation.Language.FunctionDefinitionAst] -and $node.Name -eq 'Resolve-InstallerSystemDrive'},$true))
if ($functions.Count -ne 1) { throw 'Expected exactly the corrected lifecycle drive resolver' }
# Execute only the resolver definition; never dot-source the installer lifecycle.
. ([scriptblock]::Create($functions[0].Extent.Text))
$source=Get-Content -LiteralPath $LifecycleScript -Raw
if (-not $source.Contains('$envMap[''SystemDrive''] = Resolve-InstallerSystemDrive $envMap[''SystemRoot'']')) { throw 'Lifecycle envMap does not use the validated resolver' }
$checks=0
foreach ($case in @(
  @{root='C:\Windows';inherited=$null;expected='C:'},
  @{root='D:\Windows';inherited=$null;expected='D:'},
  @{root='c:\Windows';inherited='C:';expected='C:'},
  @{root='C:/Windows';inherited='c:';expected='C:'}
)) {
  if ((Resolve-InstallerSystemDrive $case.root $case.inherited) -cne $case.expected) { throw 'Wrong derived drive' }
  $checks++
}
foreach ($case in @(
  @{root='Windows';inherited=$null}, @{root='C:Windows';inherited=$null},
  @{root='\Windows';inherited=$null}, @{root='\\server\Windows';inherited=$null},
  @{root='%SystemDrive%\Windows';inherited=$null}, @{root='C:\%windir%';inherited=$null},
  @{root='C:\Windows';inherited='D:'}, @{root='C:\Windows';inherited=''},
  @{root='C:\Windows';inherited='%SystemDrive%'}
)) {
  $rejected=$false
  try { Resolve-InstallerSystemDrive $case.root $case.inherited | Out-Null } catch { $rejected=$true }
  if (-not $rejected) { throw 'Invalid root or inconsistent inherited drive was admitted' }
  $checks++
}
$actual=Resolve-InstallerSystemDrive $env:SystemRoot ([Environment]::GetEnvironmentVariable('SystemDrive','Process'))
if ($actual -ine ([IO.Path]::GetPathRoot($env:SystemRoot).TrimEnd([char[]]'\/'))) { throw 'Native SystemRoot drive differs' }
$checks++
@{schema=1;passed=$true;checks=$checks;native_windows=$true;system_root=$env:SystemRoot;system_drive=$actual;installer_executed=$false;os_settings_changed=$false} |
  ConvertTo-Json | Set-Content -LiteralPath $OutputFile -Encoding utf8
Write-Host "SystemDrive lifecycle resolver regression passed: $checks checks"
