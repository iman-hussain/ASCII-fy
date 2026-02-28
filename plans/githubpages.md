# Master Blueprint: Universal ASCII-fi (Node + Browser WASM)

This document is a technical specification and implementation roadmap for transforming ASCII-fi into a universal tool. It is designed to be followed by an AI coding agent.

---

## 🎯 Project Goal
Enable **ASCII-fi** to run as a static web application on GitHub Pages (`ascii-fi.imanhussain.com`) while maintaining high-performance CLI/API functionality for Node.js environments.

---

## 🏗️ Phase 1: Shared Core Decoupling
**Goal**: Isolate the ASCII/Colour rendering logic from Node-specific spawning code.

### 🤖 AI Prompt: Phase 1
> **Task**: Extract the core frame-processing logic from `lib/converter.js` into a new class `AsciiEngine` in `lib/engine.js`.
>
> **Requirements**:
> 1. Move `CHAR_RAMP`, `BLOCK_RAMP`, and `EDGE_TABLE` logic to `lib/engine.js`.
> 2. Create an `AsciiEngine` class that manages internal state (prevFrameColors, prevFrameChars, bgModelColors, frozenChars).
> 3. Implement a `processFrame(pixels, scaledW, scaledH, ...)` method that is environment-agnostic (uses `Uint8Array`, no `Buffer`).
> 4. Rewrite `lib/converter.js` to instantiate `AsciiEngine` and pass it frames from the FFmpeg stream.
>
> **Acceptance Criteria**:
> - `npm test` passes (CLI/API functionality remains 100% intact).
> - `lib/engine.js` contains zero imports from `node:*` or Node-specific libraries.

---

## ⚡ Phase 2: Browser WASM Backend
**Goal**: Implement FFmpeg processing via WebAssembly.

### 🤖 AI Prompt: Phase 2
> **Task**: Create `lib/web-converter.js` for browser-side video processing.
>
> **Requirements**:
> 1. Integrate `@ffmpeg/ffmpeg` and `@ffmpeg/util`.
> 2. Implement `convertWithWasm(file, options)` which:
>    - Loads `ffmpeg.wasm`.
>    - Writes input file to WASM virtual FS.
>    - Runs FFmpeg to output `rawvideo` via pipes or temporary files.
>    - Streams chunks to `AsciiEngine`.
> 3. Implement a fallback for browsers without `SharedArrayBuffer` support using a single-threaded version or a clear error message.
>
> **Acceptance Criteria**:
> - A test script can successfully convert a 5-second MP4 to ASCII inside a browser environment (using a local server).

---

## 🖥️ Phase 3: Hybrid UI Logic
**Goal**: Make the GUI capable of choosing between the Local API (Node) and the WASM Engine.

### 🤖 AI Prompt: Phase 3
> **Task**: Refactor `gui/app.js` and `gui/js/api.js` for environment detection.
>
> **Requirements**:
> 1. Implement `isStandalone()` detection (check `window.location.hostname`).
> 2. Update `startConversion()`:
>    - If `localhost`: Send conversion request to `/api/convert` (existing logic).
>    - If `GitHub Pages`: Use Phase 2's WASM converter.
> 3. Add a "Standalone Mode" toggle/status in the UI footer so the user knows if they are using Node or WASM.
> 4. Add `coi-serviceworker.js` to `gui/index.html` to enable `SharedArrayBuffer` on GitHub Pages.
>
> **Acceptance Criteria**:
> - GUI functions correctly when served from a simple static server (e.g. `npx serve`) without a backend.

---

## 🌐 Phase 4: Custom Domain & Deployment
**Goal**: Configure Namecheap and GitHub Pages for `ascii-fi.imanhussain.com`.

### 🤖 AI Prompt: Phase 4 (Manual Task)
> **Task**: Configure DNS and GitHub Settings.
>
> **Requirements**:
> 1. **Namecheap**: Add CNAME record `ascii-fi` -> `[username].github.io`.
> 2. **Repository**:
>    - Root contains a `CNAME` file with `ascii-fi.imanhussain.com`.
>    - GitHub Actions workflow (or manual push) to `gh-pages` branch containing the `gui/` assets flattened to root.
> 3. **SSL**: Enforce HTTPS in GitHub Settings.
>
> **Acceptance Criteria**:
> - Navigating to `https://ascii-fi.imanhussain.com` loads the GUI.

---

## 📦 Phase 5: Portable Launchers
**Goal**: Create bootstrap scripts that allow users to either run the full repo or download a single script to bootstrap the entire project.

### 🤖 AI Prompt: Phase 5
> **Task**: Re-implement `start.bat` and `start.sh` as advanced "Dual-Mode" launchers.
>
> **Requirements**:
> 1. **Initial Environment Check**:
>    - Verify `node` and `npm` are installed.
>    - Verify `git` is installed.
>    - *Fallback*: If `git` is missing but the repo is present (ZIP download), continue. If missing AND repo missing, show error with download link.
> 2. **Repo Verification & Bootstrap**:
>    - **Scenario A: Full Repo**: If `.git` directory exists, run `git pull` to ensure latest version.
>    - **Scenario B: Single Script**: If `.git` and `package.json` are missing:
>      - Initialize a new repo: `git init`.
>      - Add remote: `git remote add origin https://github.com/iman-hussain/ASCII-fy.git`.
>      - Fetch and Checkout: `git fetch`, `git checkout -f main`.
> 3. **Dependency & Model Management**:
>    - Run `npm install` if `node_modules` is missing or `package.json` changed.
>    - Verify `models/selfie.onnx` exists; download via PowerShell/curl if missing.
> 4. **Execution**:
>    - Launch the GUI via `node gui/server.js`.
>
> **Acceptance Criteria**:
> - Running `start.bat` in a folder containing *only* that file successfully pulls the entire repo and starts the app.
> - Running `start.bat` inside a pre-existing `git clone` updates the code and starts the app.

---

## 🗺️ Project File Map (Post-Refactor)
```text
ASCII-fy/
├── gui/                  # Static assets + Shared GUI code
│   ├── js/
│   │   ├── api.js        # Hybrid API (WASM vs Fetch)
│   │   ├── wasm.js       # WASM orchidestration logic [NEW]
│   │   └── ...
│   └── index.html        # Main Entry (Universal)
├── lib/                  # Hybrid Library
│   ├── engine.js         # Shared ASCII Logic (Pixel Processing) [NEW]
│   ├── converter.js      # Node FFmpeg Adapter (High Perf)
│   ├── web-converter.js  # WASM FFmpeg Adapter (Universal) [NEW]
│   └── ...
├── scripts/
│   └── ascii-player.js   # Standalone ANSI Player
├── index.js              # Node CLI Entry
├── start.bat             # Portable Windows Launcher
├── start.sh              # Portable Unix Launcher
└── CNAME                 # Custom domain marker for GitHub Pages
```
