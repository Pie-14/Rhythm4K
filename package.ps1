# 打包成可以直接发给别人的 zip
# 用法： powershell -ExecutionPolicy Bypass -File package.ps1
# 产物： dist\Rhythm4K-<版本>.zip

param([switch]$Public)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$version = '0.4.0'
$name = "Rhythm4K-$version"
$dist = Join-Path $root 'dist'
$stage = Join-Path $dist $name

if (-not (Test-Path (Join-Path $root 'www\index.html'))) {
    throw "这个脚本要放在 Rhythm4K 根目录（找不到 www\index.html）"
}

if (Test-Path $stage) { Remove-Item $stage -Recurse -Force }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# 只拷运行必需的东西
Copy-Item (Join-Path $root 'www') -Destination $stage -Recurse
if ($Public) {
    # 公开分发/Release 用的干净包：去掉第三方音频与封面
    $audio = Join-Path $stage 'www\audio'
    if (Test-Path $audio) { Remove-Item $audio -Recurse -Force }
}
foreach ($f in @('启动游戏.bat', '重建启动方式.ps1', 'README.md', 'LICENSE')) {
    $p = Join-Path $root $f
    if (Test-Path $p) { Copy-Item $p -Destination $stage }
}

# 给不写代码的人看的说明
$txt = @"
Rhythm4K $version
================================

怎么开始
  1. 双击「启动游戏.bat」
  2. 点「内置示例曲」先试一下手感
  3. 把 .osz 谱面文件拖进窗口就能打自己的歌

如果双击没反应
  - 看看同目录下有没有 launch.log，里面记录了找到了哪个浏览器
  - 直接双击 www\index.html 也行（用默认浏览器打开，会有地址栏）

需要的环境
  Windows + Edge 或 Chrome（或任意 Chromium 内核浏览器）
  不需要安装任何东西，不需要联网

操作
  D F J K 打歌     空格 开始/重试     Esc 暂停     F11 全屏

说明
  谱面、音乐、背景素材的版权属于各自作者，本程序不自带任何第三方素材。
  内置示例曲的音频是程序实时合成的。
"@
Set-Content -Path (Join-Path $stage '使用说明.txt') -Value $txt -Encoding UTF8

# 别把本机运行时垃圾打进去
Get-ChildItem $stage -Recurse -File -Include 'launch.log', 'check.txt', '*.lnk' -ErrorAction SilentlyContinue |
    Remove-Item -Force -ErrorAction SilentlyContinue

$zipDir = $dist
if ($Public) {
    $zipDir = Join-Path $dist 'release'
    New-Item -ItemType Directory -Force -Path $zipDir | Out-Null
}
$zip = Join-Path $zipDir "$name.zip"
if (Test-Path $zip) { Remove-Item $zip -Force }
Compress-Archive -Path $stage -DestinationPath $zip -CompressionLevel Optimal

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host ""
if ($Public) { Write-Host "(公开版：不含 www\audio)" }
Write-Host "已生成  $zip  ($size KB)"
Write-Host "包内文件："
Get-ChildItem $stage | ForEach-Object { Write-Host ("  " + $_.Name) }
