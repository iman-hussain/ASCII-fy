@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"
title ASCII-fy GUI

where node >nul 2>nul
if !errorlevel! neq 0 (
	echo ERROR: Node.js is not installed or not in PATH.
	echo Please install Node.js from https://nodejs.org/
	pause
	exit /b 1
)

if not exist "%ROOT%node_modules\." (
	echo Installing dependencies...
	call npm install
	if !errorlevel! neq 0 (
		echo ERROR: npm install failed.
		pause
		exit /b 1
	)
)

set "MODEL_PATH=%ROOT%models\selfie.onnx"
if not exist "%MODEL_PATH%" (
	echo Downloading ML model ^(selfie.onnx^)...
	powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = $env:ASCII_FY_MODEL_URL; if (-not $url) { $url = 'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/main/onnx/model.onnx' }; $out = 'models\\selfie.onnx'; if (!(Test-Path $out)) { New-Item -ItemType Directory -Force -Path 'models' | Out-Null; Invoke-WebRequest -Uri $url -OutFile $out }"
)

node gui\server.js
if !errorlevel! neq 0 (
	echo.
	echo ERROR: Server exited with an error.
	pause
	exit /b 1
)
pause
