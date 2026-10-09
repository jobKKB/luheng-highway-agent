param(
    [Parameter(Mandatory)][string]$ExpectedIcon,
    [Parameter(Mandatory)][string[]]$Executables,
    [Parameter(Mandatory)][string]$OutputDirectory
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
New-Item -ItemType Directory -Force -Path $OutputDirectory | Out-Null

function Get-IconFingerprint([Drawing.Bitmap]$Bitmap) {
    # Compare decoded pixels rather than container encodings or resource order.
    if ($Bitmap.Width -ne 32 -or $Bitmap.Height -ne 32) { throw 'Expected a 32-pixel shell icon' }
    $bytes = [Collections.Generic.List[byte]]::new()
    for ($y = 0; $y -lt 32; $y++) {
        for ($x = 0; $x -lt 32; $x++) {
            $pixel = $Bitmap.GetPixel($x, $y)
            $value = if ($pixel.A -eq 0) { 0 } else { $pixel.ToArgb() }
            $bytes.AddRange([BitConverter]::GetBytes([int]$value))
        }
    }
    $hasher = [Security.Cryptography.SHA256]::Create()
    try { return ([BitConverter]::ToString($hasher.ComputeHash($bytes.ToArray()))).Replace('-', '').ToLowerInvariant() }
    finally { $hasher.Dispose() }
}

$reference = [Drawing.Icon]::ExtractAssociatedIcon((Resolve-Path -LiteralPath $ExpectedIcon).Path)
if ($null -eq $reference) { throw 'Approved artwork has no shell icon' }
$referenceBitmap = $reference.ToBitmap()
try {
    $expected = Get-IconFingerprint $referenceBitmap
    $referenceBitmap.Save((Join-Path $OutputDirectory 'expected-icon.png'), [Drawing.Imaging.ImageFormat]::Png)
} finally { $referenceBitmap.Dispose(); $reference.Dispose() }
$checks = @()
foreach ($executable in $Executables) {
    $resolved = (Resolve-Path -LiteralPath $executable).Path
    $icon = [Drawing.Icon]::ExtractAssociatedIcon($resolved)
    if ($null -eq $icon) { throw 'Executable has no shell icon' }
    $bitmap = $icon.ToBitmap()
    try {
        $digest = Get-IconFingerprint $bitmap
        $bitmap.Save((Join-Path $OutputDirectory ([IO.Path]::GetFileNameWithoutExtension($resolved) + '-icon.png')), [Drawing.Imaging.ImageFormat]::Png)
        $checks += @{file=[IO.Path]::GetFileName($resolved); pixelSha256=$digest; matches=($digest -eq $expected)}
    } finally { $bitmap.Dispose(); $icon.Dispose() }
}
@{expectedPixelSha256=$expected; checks=$checks} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDirectory 'branding-verification.json') -Encoding utf8
if ($checks.Count -eq 0 -or $checks.Where({-not $_.matches}).Count) { throw 'Executable icon differs from the approved Luheng artwork' }
Write-Output 'Actual Windows executable shell icons match the approved Luheng artwork'
