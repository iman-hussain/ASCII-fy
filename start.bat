@echo off
setlocal
set "ROOT=%~dp0"
cd /d "%ROOT%"
title ASCII-fy GUI
set "MODEL_PATH=%ROOT%models\selfie.onnx"
if not exist "%MODEL_PATH%" (
	echo Downloading ML model (selfie.onnx)...
	powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = $env:ASCII_FY_MODEL_URL; if (-not $url) { $url = 'https://github.com/onnx/models/raw/main/vision/body_analysis/selfie_segmentation/model/selfie_segmentation_256x256.onnx' }; $out = 'models\\selfie.onnx'; if (!(Test-Path $out)) { New-Item -ItemType Directory -Force -Path 'models' | Out-Null; Invoke-WebRequest -Uri $url -OutFile $out }"
)
node gui\server.js
