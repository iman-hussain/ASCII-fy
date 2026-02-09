@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
title ASCII-fy GUI
node gui\server.js
