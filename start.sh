#!/usr/bin/env bash
set -e
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd)"
cd "$ROOT"

echo ""
echo "========================================"
echo "        ASCII-fi Universal Loader"
echo "========================================"
echo ""

# 1. Initial Environment Check
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
    echo "[ERROR] Node.js or npm is not installed or not in PATH."
    echo "Please install Node.js from https://nodejs.org/"
    exit 1
fi

HAS_GIT=0
if command -v git >/dev/null 2>&1; then
    HAS_GIT=1
fi

# 2. Repo Verification & Bootstrap
if [ "$HAS_GIT" -eq 1 ]; then
    if [ -d "$ROOT/.git" ]; then
        # Scenario A: Full Repo exists
        echo "[INFO] Existing repository found. Checking for updates..."
        git pull origin main
    elif [ ! -f "$ROOT/package.json" ]; then
        # Scenario B: Single Script in an empty folder
        echo "[INFO] Bootstrapping ASCII-fi repository..."
        git init
        git remote add origin https://github.com/iman-hussain/ASCII-fy.git
        git fetch
        if ! git checkout -f main; then
            echo "[ERROR] Failed to bootstrap repository."
            exit 1
        fi
    fi
else
    if [ ! -f "$ROOT/package.json" ]; then
        echo "[ERROR] Git is not installed, and the repository files are missing."
        echo "Please either install Git or download the full Repository ZIP from GitHub."
        exit 1
    else
        echo "[WARN] Git is not installed. Skipping auto-updates."
    fi
fi

# 3. Dependency Management
if [ ! -d "$ROOT/node_modules" ]; then
    echo "[INFO] Installing Node.js dependencies..."
    if ! npm install; then
        echo "[ERROR] npm install failed."
        exit 1
    fi
fi

# Model Check
MODEL_URL="${ASCII_FY_MODEL_URL:-https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/main/onnx/model.onnx}"
MODEL_PATH="$ROOT/models/selfie.onnx"
if [ ! -f "$MODEL_PATH" ]; then
    echo "[INFO] Downloading required ML model (selfie.onnx)..."
    mkdir -p "$ROOT/models"
    if command -v curl >/dev/null 2>&1; then
        curl -L "$MODEL_URL" -o "$MODEL_PATH"
    elif command -v wget >/dev/null 2>&1; then
        wget -O "$MODEL_PATH" "$MODEL_URL"
    else
        echo "[ERROR] Missing curl or wget. Please download the model manually to $MODEL_PATH"
        exit 1
    fi
fi

# 4. Execution
echo ""
echo "[INFO] Starting ASCII-fi Local Server..."
if ! node gui/server.js; then
    echo ""
    echo "[ERROR] Server exited unexpectedly."
    exit 1
fi
