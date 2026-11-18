Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Split-Path -Parent $PSScriptRoot
$srcRoot = Join-Path $repoRoot "src"

function Get-RelPath([string]$fullPath) {
	return $fullPath.Substring($repoRoot.Length + 1).Replace('\', '/')
}

$allSrcFiles = @(Get-ChildItem -Path $srcRoot -Recurse -File | Sort-Object FullName)

Write-Output "=== [1] src/ > 500 linhas ==="
$over500 = @()
foreach ($file in $allSrcFiles) {
	$lineCount = [System.IO.File]::ReadAllLines($file.FullName).Length
	if ($lineCount -gt 500) {
		$over500 += "$(Get-RelPath $file.FullName): $lineCount"
	}
}
if ($over500.Count -eq 0) { Write-Output "  (nenhum)" } else { $over500 | ForEach-Object { Write-Output "  $_" } }

Write-Output "=== [2] Imports cruzados client <-> server ==="
$crossImports = @()
$serverFiles = @(Get-ChildItem -Path (Join-Path $srcRoot "server") -Recurse -File | Sort-Object FullName)
foreach ($file in $serverFiles) {
	$matches = @(Select-String -Path $file.FullName -Pattern '(?:from|import|require)\s*\(?["''][^"'']*(?:^|[/\\])client(?:[/\\]|["''])')
	foreach ($m in $matches) {
		$crossImports += "$(Get-RelPath $file.FullName):$($m.LineNumber): $($m.Line.Trim())"
	}
}
$clientFiles = @(Get-ChildItem -Path (Join-Path $srcRoot "client") -Recurse -File | Sort-Object FullName)
foreach ($file in $clientFiles) {
	$matches = @(Select-String -Path $file.FullName -Pattern '(?:from|import|require)\s*\(?["''][^"'']*(?:^|[/\\])server(?:[/\\]|["''])')
	foreach ($m in $matches) {
		$crossImports += "$(Get-RelPath $file.FullName):$($m.LineNumber): $($m.Line.Trim())"
	}
}
if ($crossImports.Count -eq 0) { Write-Output "  (nenhum)" } else { $crossImports | ForEach-Object { Write-Output "  $_" } }

Write-Output "=== [3] Vector3/Color3/UDim2 em src/shared/ ==="
$sharedVisuals = @()
$sharedFiles = @(Get-ChildItem -Path (Join-Path $srcRoot "shared") -Recurse -File | Sort-Object FullName)
foreach ($file in $sharedFiles) {
	$matches = @(Select-String -Path $file.FullName -Pattern '\b(Vector3|Color3|UDim2)\b')
	foreach ($m in $matches) {
		$sharedVisuals += "$(Get-RelPath $file.FullName):$($m.LineNumber): $($m.Line.Trim())"
	}
}
if ($sharedVisuals.Count -eq 0) { Write-Output "  (nenhum)" } else { $sharedVisuals | ForEach-Object { Write-Output "  $_" } }

Write-Output "=== [4] String literal de nome de Remote fora de Remotes.ts ==="
$remotesFile = Join-Path $srcRoot "shared\Remotes.ts"
$remotesRaw = [System.IO.File]::ReadAllText($remotesFile)
$remoteNames = @(
	[regex]::Matches($remotesRaw, '(?m)^\s*\w+\s*:\s*"([^"]+)"') | ForEach-Object { [regex]::Escape($_.Groups[1].Value) }
) + "VFXEvent"
$remotePattern = "[""'](" + ($remoteNames -join '|') + ")[""']"

$remoteLiterals = @()
foreach ($file in $allSrcFiles) {
	if ($file.FullName -eq $remotesFile) { continue }
	$matches = @(Select-String -Path $file.FullName -Pattern $remotePattern)
	foreach ($m in $matches) {
		$remoteLiterals += "$(Get-RelPath $file.FullName):$($m.LineNumber): $($m.Line.Trim())"
	}
}
if ($remoteLiterals.Count -eq 0) { Write-Output "  (nenhum)" } else { $remoteLiterals | ForEach-Object { Write-Output "  $_" } }
