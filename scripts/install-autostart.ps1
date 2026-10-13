# 注册「登录 Windows 时自动启动 ps5watch 控制台」，并移除旧版每日计划任务（定时已内置到服务里）
# 用法：powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1 [-Uninstall]
param([switch]$Uninstall)

$root = Split-Path -Parent $PSScriptRoot
$vbs = Join-Path $PSScriptRoot 'start-hidden.vbs'
$name = 'PS5Watch Console'

if ($Uninstall) {
  schtasks /Delete /F /TN $name 2>$null | Out-Null
  Write-Host "已移除开机自启：$name"
  exit 0
}

schtasks /Create /F /TN $name /SC ONLOGON /RL LIMITED /TR "wscript.exe `"$vbs`"" | Out-Null
if ($LASTEXITCODE -ne 0) { Write-Error '注册开机自启失败'; exit 1 }
Write-Host "已注册开机自启：$name"

schtasks /Query /TN 'PS5Watch' 2>$null | Out-Null
if ($LASTEXITCODE -eq 0) {
  schtasks /Delete /F /TN 'PS5Watch' | Out-Null
  Write-Host '已移除旧版每日计划任务 PS5Watch（定时运行已由控制台接管）'
}

$port = 5175
try { $port = (Get-Content (Join-Path $root 'state\server.json') -Raw | ConvertFrom-Json).port } catch {}
try {
  Invoke-WebRequest -UseBasicParsing "http://127.0.0.1:$port/api/job-types" -TimeoutSec 2 | Out-Null
  Write-Host "控制台已在运行：http://127.0.0.1:$port"
} catch {
  schtasks /Run /TN $name | Out-Null
  Write-Host "控制台已启动：http://127.0.0.1:$port"
}
