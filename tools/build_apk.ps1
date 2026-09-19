# 一键重新打包安卓 App
#
# 用法：在项目根目录执行
#     powershell -ExecutionPolicy Bypass -File tools\build_apk.ps1
#
# 改完 static/ 里的任何东西（界面、分类规则），跑一次这个脚本就会生成新的 APK。

$ErrorActionPreference = "Stop"
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root

$jdk = "D:\Program Files\Java\jdk-17"
if (-not (Test-Path -LiteralPath $jdk)) {
    $jdk = (Get-Command java).Source | Split-Path -Parent | Split-Path -Parent
}
$env:JAVA_HOME = $jdk
$env:ANDROID_HOME = "C:\Users\$env:USERNAME\AppData\Local\Android\Sdk"
$env:ANDROID_SDK_ROOT = $env:ANDROID_HOME

Write-Host "1/4 组装网页资源..." -ForegroundColor Cyan
& "$root\.venv\Scripts\python.exe" "$root\tools\build_app.py"

Write-Host "2/4 同步到安卓工程..." -ForegroundColor Cyan
Push-Location "$root\app"
& npx cap sync android | Out-Null
Pop-Location

Write-Host "3/4 编译 APK..." -ForegroundColor Cyan
Push-Location "$root\app\android"
& .\gradlew.bat assembleRelease --console=plain --no-watch-fs
Pop-Location

Write-Host "4/4 拷贝产物..." -ForegroundColor Cyan
$src = "$root\app\android\app\build\outputs\apk\release\app-release.apk"
$dst = "$root\考公错题本.apk"
Copy-Item -LiteralPath $src -Destination $dst -Force

$size = [math]::Round((Get-Item -LiteralPath $dst).Length / 1MB, 1)
Write-Host ""
Write-Host "完成：$dst（$size MB）" -ForegroundColor Green
Write-Host "把这个文件传到手机，点开安装即可（需要允许「安装未知来源应用」）。"
