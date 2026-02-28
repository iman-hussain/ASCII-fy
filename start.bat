@echo off
setlocal enabledelayedexpansion
set "ROOT=%~dp0"
cd /d "%ROOT%"
title ASCII-fi GUI

echo.
echo ========================================
echo         ASCII-fi Universal Loader
echo ========================================
echo.

:: 1. Initial Environment Check
where node >nul 2>nul
if !errorlevel! neq 0 (
	echo [ERROR] Node.js is not installed or not in PATH.
	echo Please install Node.js from https://nodejs.org/
	pause
	exit /b 1
)

where git >nul 2>nul
set HAS_GIT=!errorlevel!

:: 2. Repo Verification & Bootstrap
if !HAS_GIT! equ 0 (
	if exist "%ROOT%\.git" (
		:: Scenario A: Full Repo exists
		echo [INFO] Existing repository found. Checking for updates...
		git pull origin main
	) else if not exist "%ROOT%\package.json" (
		:: Scenario B: Single Script in an empty folder
		echo [INFO] Bootstrapping ASCII-fi repository...
		git init
		git remote add origin https://github.com/iman-hussain/ASCII-fy.git
		git fetch
		git checkout -f main
		if !errorlevel! neq 0 (
			echo [ERROR] Failed to bootstrap repository.
			pause
			exit /b 1
		)
	)
) else (
	if not exist "%ROOT%\package.json" (
		echo [ERROR] Git is not installed, and the repository files are missing.
		echo Please either install Git or download the full Repository ZIP from GitHub.
		pause
		exit /b 1
	) else (
		echo [WARN] Git is not installed. Skipping auto-updates.
	)
)

:: 3. Dependency Management
if not exist "%ROOT%\node_modules\." (
	echo [INFO] Installing Node.js dependencies...
	call npm install
	if !errorlevel! neq 0 (
		echo [ERROR] npm install failed.
		pause
		exit /b 1
	)
)

:: Model Check
set "MODEL_PATH=%ROOT%\models\selfie.onnx"
if not exist "%MODEL_PATH%" (
	echo [INFO] Downloading required ML model (selfie.onnx)...
	powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = $env:ASCII_FY_MODEL_URL; if (-not $url) { $url = 'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/main/onnx/model.onnx' }; $out = 'models\selfie.onnx'; if (!(Test-Path $out)) { New-Item -ItemType Directory -Force -Path 'models' | Out-Null; Invoke-WebRequest -Uri $url -OutFile $out }"
)

:: 4. Execution
echo.
echo [INFO] Starting ASCII-fi Local Server...
node gui\server.js
if !errorlevel! neq 0 (
	echo.
	echo [ERROR] Server exited unexpectedly.
	pause
	exit /b 1
)
pause
