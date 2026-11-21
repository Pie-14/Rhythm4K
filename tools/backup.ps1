# backup.ps1 — 给 rhythm4k 的 www 做快照
# 用法：powershell -File tools\backup.ps1 [标签]
param([string]$Label = "")
$root = Split-Path -Parent $PSScriptRoot
$base = Join-Path $root ".backup"
$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$name = if ($Label) { "$stamp-$Label" } else { $stamp }
$dst = Join-Path $base $name
New-Item -ItemType Directory -Force -Path $dst | Out-Null
Copy-Item (Join-Path $root "www\js\*.js") $dst -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root "www\index.html") $dst -Force -ErrorAction SilentlyContinue
Copy-Item (Join-Path $root "www\css\style.css") $dst -Force -ErrorAction SilentlyContinue
Write-Host "备份完成: $dst"

# 只保留最近 12 份
$all = Get-ChildItem $base -Directory | Sort-Object Name
if ($all.Count -gt 12) {
  $all | Select-Object -First ($all.Count - 12) | ForEach-Object {
    Remove-Item $_.FullName -Recurse -Force -ErrorAction SilentlyContinue
    Write-Host "  清理旧备份: $($_.Name)"
  }
}
