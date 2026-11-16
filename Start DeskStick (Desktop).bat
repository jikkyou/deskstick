@echo off
title Daddy's DeskStick - Desktop Layer
cd /d "%~dp0"

netstat -ano | findstr ":7788" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [1/2] 启动本地服务...
  pushd "%~dp0.."
  start "deskstick-service" /min cmd /c "node server.js"
  popd
  ping -n 3 127.0.0.1 >nul
) else (
  echo [1/2] 服务已在运行
)

if not exist "%~dp0desktop\DeskHost.exe" (
  echo [错误] 找不到 desktop\DeskHost.exe
  pause
  exit /b 1
)

echo [2/2] 启动桌面层宿主...
echo.
echo   DeskStick will sit桌面图标之上、所有窗口之下。
echo   按 Win+D 或最小化其他窗口即可看到。
echo   退出：右键托盘图标 - 退出。
echo.
pushd "%~dp0desktop"
start "" "DeskHost.exe"
popd
