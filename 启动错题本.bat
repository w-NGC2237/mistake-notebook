@echo off
chcp 65001 >nul
cd /d "%~dp0"
title 错题本

if not exist ".venv\Scripts\python.exe" goto :setup
goto :run

:setup
echo.
echo   首次运行，正在安装运行环境（约 3-5 分钟，只需一次）...
echo.
python -m venv .venv || goto :fail
".venv\Scripts\python.exe" -m pip install --upgrade pip -q
".venv\Scripts\python.exe" -m pip install -r requirements.txt || goto :fail

:run
start "" powershell -NoProfile -WindowStyle Hidden -Command "Start-Sleep -Seconds 3; Start-Process 'http://127.0.0.1:8765'"
".venv\Scripts\python.exe" server.py
goto :eof

:fail
echo.
echo   环境安装失败。请确认已安装 Python 3.10+，并且能访问网络。
echo.
pause
