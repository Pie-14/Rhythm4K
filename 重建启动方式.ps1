# 重建启动方式（快捷方式 + bat）
# 用途：文件夹挪了位置、或者快捷方式丢了，跑一次这个脚本就行。
# 用法：右键这个文件 → 使用 PowerShell 运行；或在 PowerShell 里：
#   powershell -ExecutionPolicy Bypass -File "重建启动方式.ps1"

$ErrorActionPreference = 'Stop'
$root = $MyInvocation.MyCommand.Path | Split-Path -Parent

$html = Join-Path $root 'www\index.html'
if (-not (Test-Path $html)) { throw "这个文件夹里没有 www\index.html，脚本要放在 Rhythm4K 根目录" }

# ---- 找浏览器 ----
$candidates = @(
    (Join-Path ${env:ProgramFiles(x86)} 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:LOCALAPPDATA 'Microsoft\Edge\Application\msedge.exe'),
    (Join-Path $env:ProgramFiles 'Google\Chrome\Application\chrome.exe'),
    (Join-Path ${env:ProgramFiles(x86)} 'Google\Chrome\Application\chrome.exe')
)
$browser = $candidates | Where-Object { $_ -and (Test-Path $_) } | Select-Object -First 1
if (-not $browser) { throw "没找到 Edge 或 Chrome" }

$uri = ([System.Uri]$html).AbsoluteUri

# 独立配置目录：绝对不能和用户平时的 Edge 共用，否则单实例锁冲突会让 Edge 直接 abort、不弹窗
$profile = Join-Path $env:LOCALAPPDATA 'Rhythm4K\profile'
if (-not (Test-Path $profile)) { New-Item -ItemType Directory -Force -Path $profile | Out-Null }

$args2 = '--app="' + $uri + '" --user-data-dir="' + $profile + '" --window-size=1920,1080 --start-fullscreen --no-first-run --no-default-browser-check --disable-background-mode --allow-file-access-from-files'

# ---- 快捷方式 ----
$ws = New-Object -ComObject WScript.Shell
$sc = $ws.CreateShortcut((Join-Path $root 'Rhythm4K.lnk'))
$sc.TargetPath = $browser
$sc.Arguments = $args2
$sc.WorkingDirectory = $root
$icon = Join-Path $root 'launcher\icon.ico'
if (Test-Path $icon) { $sc.IconLocation = $icon }
$sc.Description = 'Rhythm4K 4K rhythm game'
$sc.Save()
Write-Host "已重建 Rhythm4K.lnk  →  $browser"

# ---- bat ----
$lines = @(
    '@echo off'
    'setlocal'
    'set "ROOT=%~dp0"'
    'set "HTML=%ROOT%www\index.html"'
    'if not exist "%HTML%" echo Cannot find www\index.html & pause & exit /b 1'
    'set "BROWSER=' + $browser + '"'
    'set "PROFILE=%LocalAppData%\Rhythm4K\profile"'
    'if not exist "%PROFILE%" mkdir "%PROFILE%"'
    'set "URL=file:///%HTML:\=/%"'
    'echo %date% %time% launching > "%ROOT%launch.log"'
    'start "" "%BROWSER%" --app="%URL%" --user-data-dir="%PROFILE%" --window-size=1920,1080 --start-fullscreen --no-first-run --no-default-browser-check --allow-file-access-from-files'
    'exit /b'
)
$bat = ($lines -join "`r`n") + "`r`n"
[System.IO.File]::WriteAllText((Join-Path $root '启动游戏.bat'), $bat, (New-Object System.Text.ASCIIEncoding))
Write-Host "已重建 启动游戏.bat"
Write-Host ""
Write-Host "现在双击 Rhythm4K.lnk 就能开始游戏。"
