@echo off
title 停止桌贴
echo 正在停止 7788 端口上的服务...
for /f "tokens=5" %%a in ('netstat -ano ^| findstr ":7788" ^| findstr "LISTENING"') do (
  taskkill /PID %%a /F >nul 2>&1
  echo 已停止 PID %%a
)
echo 完成。
ping -n 3 127.0.0.1 >nul
