#!/usr/bin/env bash
set -e
cd "$(dirname "$0")"
MODEL_URL="${ASCII_FY_MODEL_URL:-https://github.com/onnx/models/raw/main/vision/body_analysis/selfie_segmentation/model/selfie_segmentation_256x256.onnx}"
MODEL_PATH="models/selfie.onnx"
if [ ! -f "$MODEL_PATH" ]; then
	echo "Downloading ML model (selfie.onnx)..."
	mkdir -p models
	if command -v curl >/dev/null 2>&1; then
		curl -L "$MODEL_URL" -o "$MODEL_PATH"
	elif command -v wget >/dev/null 2>&1; then
		wget -O "$MODEL_PATH" "$MODEL_URL"
	else
		echo "Missing curl or wget. Please download the model manually to $MODEL_PATH"
	fi
fi
node gui/server.js
