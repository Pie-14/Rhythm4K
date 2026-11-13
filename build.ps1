# 重新编译 Rhythm4K.exe（用系统自带的 .NET Framework 编译器，无需安装依赖）
# 用法： powershell -ExecutionPolicy Bypass -File build.ps1

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path

$csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319\csc.exe'
if (-not (Test-Path $csc)) {
    $csc = Join-Path $env:WINDIR 'Microsoft.NET\Framework\v4.0.30319\csc.exe'
}
if (-not (Test-Path $csc)) { throw "找不到 csc.exe（.NET Framework 4.x 不在？）" }

# 重新生成图标
$py = Get-Command python -ErrorAction SilentlyContinue
if ($py) {
    Push-Location (Join-Path $root 'launcher')
    try { & $py.Source make_icon.py } catch { Write-Warning "图标生成失败，沿用旧 icon.ico" }
    Pop-Location
}

$out = Join-Path $root 'Rhythm4K.exe'
& $csc /nologo /target:winexe /r:System.Windows.Forms.dll `
    /win32icon:"$(Join-Path $root 'launcher\icon.ico')" `
    /out:"$out" `
    "$(Join-Path $root 'launcher\Launcher.cs')"

if ($LASTEXITCODE -ne 0) { throw "编译失败" }
Write-Host "已生成 $out ($((Get-Item $out).Length) bytes)"
