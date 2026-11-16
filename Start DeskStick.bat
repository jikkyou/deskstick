@echo off
title Daddy's DeskStick - Web
cd /d "%~dp0"

netstat -ano | findstr ":7788" | findstr "LISTENING" >nul
if errorlevel 1 (
  echo [1/2] 启动本地服务...
  start "deskstick-service" /min cmd /c "node server.js"
  ping -n 3 127.0.0.1 >nul
) else (
  echo [1/2] 服务已在运行
)

set "EDGE=C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" set "EDGE=C:\Program Files\Microsoft\Edge\Application\msedge.exe"
if not exist "%EDGE%" (
  echo 找不到 Edge，用默认浏览器打开
  start "" "http://127.0.0.1:7788/"
  exit /b
)

echo [2/2] Open DeskStick...
start "" "%EDGE%" --app=http://127.0.0.1:7788/ --start-maximized
