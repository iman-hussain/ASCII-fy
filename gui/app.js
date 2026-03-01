import { dom } from './js/dom.js';
import { state, resetState, setState } from './js/state.js';
import { formatBytes, appendLog, interceptConsole } from './js/utils.js';
import { startConvert, stopConversion, isStandalone, isWebEnvironment } from './js/api.js';
import {
	updateEstimate, updateResolution, makeEditable, updateModeFields,
	updateForegroundFields, applyPreviewBg, resetPreviewBg,
	showPreviewBgBar, updatePaletteSwatches, updateVideoFilters
} from './js/ui.js';
import {
	toggleCrop, syncCropInputsToBox, syncTrimInputsToSliders,
	syncTrimSlidersToInputs, onCropDrag, onCropDragEnd, getActiveCrop
} from './js/crop-trim.js';

// Initialize console interception ASAP to capture all console output
interceptConsole();

/* ── Core File Initialization ────────────────────────────────────────── */
export async function probeFile(pathOrFile) {
	// Guard against null or undefined input
	if (!pathOrFile) {
		appendLog('Error: Invalid file or path provided to probeFile', 'error');
		setState('videoMeta', null);
		dom.convertBtn.disabled = true;
		return false;
	}

	if (isStandalone() && pathOrFile instanceof File) {
		// --- WASM Probe ---
		// In standalone mode, we must have the raw File object since we can't upload to a server
		return new Promise((resolve) => {
			const worker = new Worker('/js/wasm/worker.js', { type: 'module' });
			let timedOut = false;

			// Add timeout for probe (120 seconds to allow FFmpeg to download from CDN)
			// FFmpeg uses: 45s primary CDN + 45s mirror CDN = 90s total, plus 30s buffer
			const timeout = setTimeout(() => {
				timedOut = true;
				appendLog("❌ Video probe timed out after 120 seconds.", "error");
				appendLog("This usually means FFmpeg failed to load from both CDN sources.", "error");
				appendLog("", "info");
				appendLog("Possible causes:", "warning");
				appendLog("1. No internet connection", "info");
				appendLog("2. CDN services (unpkg.com, jsdelivr.net) are down", "info");
				appendLog("3. Your network may be blocking CDN access", "info");
				appendLog("4. Browser security headers not properly configured (COOP/COEP)", "info");
				appendLog("", "info");
				appendLog("Solutions to try:", "warning");
				appendLog("1. Check your internet connection", "info");
				appendLog("2. Refresh the page and wait for service worker to activate (1-2 seconds)", "info");
				appendLog("3. Try a different network (e.g., mobile hotspot)", "info");
				appendLog("4. Try a different browser", "info");
				if (typeof SharedArrayBuffer === 'undefined') {
					appendLog("", "info");
					appendLog("⚠️ SharedArrayBuffer is NOT available. This is a critical issue.", "error");
					appendLog("The service worker may not have activated properly.", "error");
					appendLog("Try: Hard refresh (Ctrl+Shift+R on Windows, Cmd+Shift+R on Mac)", "warning");
				}
				dom.logArea.classList.add('active');
				setState('videoMeta', null);
				dom.convertBtn.disabled = true;
				worker.terminate();
				resolve(false);
			}, 120000);

			worker.onerror = (err) => {
				if (!timedOut) {
					clearTimeout(timeout);
					appendLog("Worker error: " + (err.message || 'Unknown error loading video processor'), "error");
					dom.logArea.classList.add('active');
					setState('videoMeta', null);
					dom.convertBtn.disabled = true;
					worker.terminate();
					resolve(false);
				}
			};

			worker.onmessage = (e) => {
				if (timedOut) return;

				const { type, info, error, level, message } = e.data;

				// Handle worker console logs
				if (type === 'LOG') {
					appendLog(message, level || 'info');
					return;
				}

				clearTimeout(timeout);

				if (type === 'PROBE_SUCCESS') {
					appendLog("Video loaded successfully!", "success");
					setState('videoMeta', info || null);
					setState('selectedPath', pathOrFile.name);
					setState('videoFileSize', pathOrFile.size);
					clampSlidersToSource();
					updateInfoBar('original');
					updateEstimate();
					dom.convertBtn.disabled = false;
					worker.terminate();
					resolve(true);
				}
				if (type === 'PROBE_ERROR') {
					appendLog("Failed to load video: " + error, "error");
					dom.logArea.classList.add('active');
					setState('videoMeta', null);
					dom.convertBtn.disabled = true;
					worker.terminate();
					resolve(false);
				}
			};

			appendLog("Loading video metadata...", "info");
			dom.logArea.classList.add('active');
			worker.postMessage({ type: 'PROBE', payload: { file: pathOrFile } });
		});

	} else {
		// --- Local Server Probe ---
		if (typeof pathOrFile !== 'string' && !(pathOrFile instanceof File)) {
			appendLog('Error: pathOrFile must be a string or File object', 'error');
			setState('videoMeta', null);
			dom.convertBtn.disabled = true;
			return false;
		}
		const path = typeof pathOrFile === 'string' ? pathOrFile : pathOrFile.name;
		try {
			const res = await fetch('/api/probe', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path }),
			});
			const data = await res.json();
			setState('videoMeta', data.meta || null);
			if (data.resolvedPath) setState('selectedPath', data.resolvedPath);
			if (data.fileSize) setState('videoFileSize', data.fileSize);

			if (!data.ok && !data.resolvedPath) {
				dom.convertBtn.disabled = true;
				return false;
			}
			clampSlidersToSource();
			updateInfoBar('original');
			updateEstimate();
			dom.convertBtn.disabled = false;
			return true;
		} catch {
			setState('videoMeta', null);
			return false;
		}
	}
}

async function selectFromDropdown(name) {
	resetState();
	showFileSelected(name);
	setState('selectedPath', name);

	const resolved = await probeFile(name);

	if (!resolved || !state.selectedPath) {
		appendLog("Failed to probe file " + name, "error");
		return;
	}

	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.src = '/api/video?path=' + encodeURIComponent(state.selectedPath);
	dom.previewVideo.classList.remove('hidden');
	dom.previewVideo.play().catch(() => { });
	dom.dropZone.classList.add('hidden');
	syncTrimSlidersToInputs();
}

async function handleFile(file, forceUpload) {
	const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
	if (file.size > MAX_FILE_SIZE) {
		appendLog(`File too large. Maximum: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB (file is ${(file.size / 1024 / 1024).toFixed(1)}MB)`, 'error');
		dom.logArea.classList.add('active');
		return;
	}

	resetState();
	setState('videoFileSize', file.size);
	setState('rawFile', file); // Store for WASM usage
	showFileSelected(file.name);

	let blobUrl = URL.createObjectURL(file);
	setState('blobUrl', blobUrl);
	dom.previewVideo.src = blobUrl;
	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.classList.remove('hidden');
	dom.previewVideo.load();
	dom.previewVideo.play().catch(() => { });
	dom.dropZone.classList.add('hidden');

	if (isStandalone()) {
		// In standalone mode, we can only probe via WASM using the raw file.
		await probeFile(file);
		return;
	}

	let resolved = false;
	if (!forceUpload) {
		resolved = await probeFile(file.name);
	}

	if (!resolved) {
		try {
			const upRes = await fetch('/api/upload', {
				method: 'POST',
				headers: {
					'Content-Type': 'application/octet-stream',
					'X-Filename': encodeURIComponent(file.name),
				},
				body: file,
			});
			const upData = await upRes.json();
			if (upData.ok && upData.resolvedPath) {
				setState('selectedPath', upData.resolvedPath);
				await probeFile(state.selectedPath);
			} else if (!upData.ok) {
				appendLog('Upload failed: ' + (upData.error || 'Unknown error'), 'error');
				dom.logArea.classList.add('active');
			} else {
				appendLog('Upload error: server did not return file path', 'error');
				dom.logArea.classList.add('active');
			}
		} catch (err) {
			appendLog('Upload error: ' + err.message, 'error');
			dom.logArea.classList.add('active');
		}
	}
}

function showFileSelected(name) {
	dom.fileHeader.classList.remove('hidden');
	dom.fileName.textContent = name;
	dom.dropZone.classList.add('hidden');
	dom.previewGif.classList.add('hidden');
	dom.previewTabs.classList.add('hidden');
	dom.tabConvertedGif.disabled = true;
	dom.tabConvertedBundle.disabled = true;
}

function resetFileSelection() {
	resetState();
	dom.fileHeader.classList.add('hidden');
	dom.previewTabs.classList.add('hidden');
	dom.previewVideoContainer.classList.add('hidden');
	dom.previewVideo.classList.add('hidden');
	dom.cropBox.classList.add('hidden');
	dom.previewGif.classList.add('hidden');
	dom.dropZone.classList.remove('hidden');
	dom.infoBar.classList.add('hidden');
	dom.estimateArea.classList.add('hidden');
	dom.resultsArea.classList.remove('active');
	dom.undoBtn.classList.add('hidden');
	resetPreviewBg();
	resetSliderMaxes();
	updateTabSizes();
	dom.convertBtn.disabled = true;
	dom.inputSelect.value = '';
	dom.previewVideo.src = '';
	dom.tabOriginal.classList.add('active');
	dom.tabConvertedGif.classList.remove('active');
	dom.tabConvertedGif.disabled = true;
	dom.tabConvertedBundle.classList.remove('active');
	dom.tabConvertedBundle.disabled = true;
	dom.bundleViewer.classList.add('hidden');
	dom.bundleIframe.classList.add('hidden');
	dom.bundleIframe.src = 'about:blank';
	dom.bundleViewer.innerHTML = '<span class="bundle-viewer-empty">No bundle yet.</span>';
	stopWebcam();
}

function clampSlidersToSource() {
	if (!state.videoMeta) return;
	if (state.videoMeta.width) {
		const maxW = state.videoMeta.width;
		dom.widthSlider.max = maxW;
		if (parseInt(dom.widthSlider.value) > maxW) {
			dom.widthSlider.value = maxW;
			dom.widthVal.textContent = maxW;
		}
	}
	if (state.videoMeta.height) {
		const maxH = state.videoMeta.height;
		dom.heightSlider.max = maxH;
		if (parseInt(dom.heightSlider.value) > maxH) {
			dom.heightSlider.value = maxH;
			dom.heightVal.textContent = maxH;
		}
	}
	if (state.videoMeta.fps) {
		const maxFps = Math.round(state.videoMeta.fps);
		dom.fpsSlider.max = maxFps;
		if (parseInt(dom.fpsSlider.value) > maxFps) {
			dom.fpsSlider.value = maxFps;
			dom.fpsVal.textContent = maxFps;
		}
	}
	if (state.videoMeta.duration) {
		dom.trimStartSlider.max = state.videoMeta.duration;
		dom.trimEndSlider.max = state.videoMeta.duration;
		dom.trimEndInp.value = state.videoMeta.duration;
		syncTrimSlidersToInputs();
		dom.trimStartVal.textContent = "0.0";
		dom.trimEndVal.textContent = state.videoMeta.duration.toFixed(1);
	}
	// Init height based on width and aspect
	syncResolution('width');
}

function syncResolution(changed) {
	if (state.videoMeta) {
		const isLocked = dom.lockAspectChk.checked;
		const srcH = state.videoMeta.height || 480;
		const srcW = (state.videoMeta.width || 640) * (state.videoMeta.sar || 1);

		// If cropping is active, use the crop dimensions for the ratio
		const activeCrop = getActiveCrop();
		let ratio;
		if (activeCrop) {
			ratio = (activeCrop.h / activeCrop.w) * (6 / 8);
		} else {
			// Character aspect ratio: rows = cols * (srcH/srcW) * (CELL_W / CELL_H)
			ratio = (srcH / srcW) * (6 / 8);
		}

		if (changed === 'width' && isLocked) {
			dom.heightSlider.value = Math.max(1, Math.round(dom.widthSlider.value * ratio));
		} else if (changed === 'height' && isLocked) {
			dom.widthSlider.value = Math.max(1, Math.round(dom.heightSlider.value / ratio));
		}
	}
	updateResolution();
}

function resetSliderMaxes() {
	dom.widthSlider.max = 250;
	dom.heightSlider.max = 250;
	dom.fpsSlider.max = 60;
}

function updateInfoBar(tab) {
	const isConverted = tab === 'converted' && state.lastConvertResult;
	if (isConverted) {
		const d = state.lastConvertResult;
		dom.infoBar.classList.remove('hidden');
		dom.infoDims.textContent = d.width + '×' + d.height;
		dom.infoFps.textContent = parseFloat(d.fps).toFixed(1);
		dom.infoFrames.textContent = (d.totalFrames || d.frames || 0).toLocaleString();
		const parts = [];
		if (d.bundleSize) parts.push(formatBytes(d.bundleSize) + ' bundle');
		if (d.gifSize) parts.push(formatBytes(d.gifSize) + ' .gif');
		dom.infoSize.textContent = parts.join(' · ') || '—';
		if (d.duration != null) dom.infoDuration.textContent = Number(d.duration).toFixed(2) + 's';
		else if (d.totalFrames && d.fps) dom.infoDuration.textContent = (d.totalFrames / d.fps).toFixed(2) + 's';
		// Clear any stale aspect-ratio override — the GIF pixel dimensions are already correct
		dom.previewGif.style.aspectRatio = '';
	} else if (state.videoMeta) {
		dom.infoBar.classList.remove('hidden');
		const sar = state.videoMeta.sar || 1;
		const visW = Math.round(state.videoMeta.width * sar);
		dom.infoDims.textContent = visW + '×' + state.videoMeta.height;
		if (state.videoMeta.fps) dom.infoFps.textContent = state.videoMeta.fps.toFixed(1);
		if (state.videoMeta.duration) {
			const sec = state.videoMeta.duration;
			dom.infoDuration.textContent = sec.toFixed(2) + 's';
			if (state.videoMeta.fps) {
				dom.infoFrames.textContent = Math.round(sec * state.videoMeta.fps).toLocaleString();
			}
		}
		dom.infoSize.textContent = state.videoFileSize ? formatBytes(state.videoFileSize) : '—';
		if (state.videoMeta.width && state.videoMeta.height) dom.previewVideo.style.aspectRatio = visW + ' / ' + state.videoMeta.height;
	} else {
		return;
	}
	updateTabSizes();
}

export function updateTabSizes() {
	dom.tabOriginalSize.textContent = state.videoFileSize ? '(' + formatBytes(state.videoFileSize) + ')' : '';
	if (state.lastConvertResult) {
		dom.tabGifSize.textContent = state.lastConvertResult.gifSize ? '(' + formatBytes(state.lastConvertResult.gifSize) + ')' : '';
		dom.tabBundleSize.textContent = state.lastConvertResult.bundleSize ? '(' + formatBytes(state.lastConvertResult.bundleSize) + ')' : '';
	} else {
		dom.tabGifSize.textContent = '';
		dom.tabBundleSize.textContent = '';
	}
}
export function showResults(d) {
	dom.resultsArea.classList.add('active');
	dom.resultActions.innerHTML = '';

	if (isStandalone()) {
		// Web Mode actions
		if (d.gifUrl && d.gifBlob) {
			addDownloadAction('Download GIF', d.gifBlob, 'ascii-fi.gif');
		} else if (d.gifUrl) {
			addDownloadAction('Download GIF', d.gifUrl, 'ascii-fi.gif');
		}
		if (d.bundleUrl) {
			addDownloadAction('Download HTML Bundle', d.bundleUrl, 'ascii-fi.html');
		}
	} else {
		// Desktop Node.js actions
		if (d.htmlPath) addAction('Open Player', d.htmlPath);
		if (d.gifPath) addAction('Open preview.gif', d.gifPath);
		if (d.outputDir) addAction('Open Folder', d.outputDir);
	}
	if (d.bundleUrl) {
		const copyBtn = document.createElement('button');
		copyBtn.className = 'btn btn-secondary';
		copyBtn.textContent = 'Copy .js';
		copyBtn.onclick = async () => {
			try {
				const resp = await fetch(d.bundleUrl + '?t=' + Date.now());
				const text = await resp.text();
				if (navigator.clipboard && navigator.clipboard.writeText) {
					await navigator.clipboard.writeText(text);
				} else {
					const ta = document.createElement('textarea');
					ta.value = text;
					document.body.appendChild(ta);
					ta.select();
					document.execCommand('copy');
					document.body.removeChild(ta);
				}
				copyBtn.textContent = 'Copied!';
				setTimeout(() => copyBtn.textContent = 'Copy .js', 2000);
			} catch (err) {
				console.error('Copy failed:', err);
			}
		};
		dom.resultActions.appendChild(copyBtn);
	}
}
function addAction(label, path) {
	const btn = document.createElement('button');
	btn.className = 'btn btn-secondary';
	btn.textContent = label;
	btn.onclick = () => {
		fetch('/api/open', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path }),
		});
	};
	dom.resultActions.appendChild(btn);
}

function addDownloadAction(label, url, filename) {
	const a = document.createElement('a');
	a.className = 'btn btn-secondary';
	a.textContent = label;
	a.href = url;
	a.download = filename;
	a.style.textDecoration = 'none';
	dom.resultActions.appendChild(a);
}

/* ── Live ASCII full-area preview ──────────────────────────── */

const _CHAR_RAMP = ' .:-=+*#%@';
const _BLOCK_RAMP = ' ░▒▓█';

let _liveRafId = null;
let _liveCanvas = null;
let _liveCtx = null;
let _liveAsciiEl = null;
let _livePipEl = null;

function startLiveAscii(videoEl, containerEl) {
	// Hidden capture canvas
	_liveCanvas = document.createElement('canvas');
	_liveCanvas.style.display = 'none';
	_liveCtx = _liveCanvas.getContext('2d', { willReadFrequently: true });

	// Full-area ASCII <pre>
	_liveAsciiEl = document.createElement('pre');
	_liveAsciiEl.className = 'live-ascii-pre';

	// PIP webcam mirror
	_livePipEl = document.createElement('video');
	_livePipEl.className = 'webcam-pip';
	_livePipEl.srcObject = videoEl.srcObject;
	_livePipEl.muted = true;
	_livePipEl.playsInline = true;
	_livePipEl.autoplay = true;
	_livePipEl.play().catch(() => { });

	// Setup container
	containerEl.style.position = 'relative';
	containerEl.style.background = '#0a0a0a';
	containerEl.style.minHeight = '360px';
	containerEl.appendChild(_liveCanvas);
	containerEl.appendChild(_liveAsciiEl);
	containerEl.appendChild(_livePipEl);

	// Hide the main video — the ASCII pre IS the preview now
	videoEl.style.opacity = '0';
	videoEl.style.position = 'absolute';
	videoEl.style.pointerEvents = 'none';

	let _lastDrawTime = 0;
	const TARGET_FPS = 12; // throttle to ~12fps to avoid starving MediaRecorder
	const FRAME_INTERVAL = 1000 / TARGET_FPS;

	function drawFrame(timestamp) {
		if (!state.webcamStream) return;
		_liveRafId = requestAnimationFrame(drawFrame);
		if (videoEl.readyState < 2) return;

		// Throttle rendering
		if (timestamp - _lastDrawTime < FRAME_INTERVAL) return;
		_lastDrawTime = timestamp;

		// ── Read UI controls ──
		const COLS = parseInt(dom.widthSlider.value) || 80;
		const charMode = dom.charMode?.value || 'ascii';
		const colourMode = dom.modeSelect?.value || 'truecolor';
		const ramp = charMode === 'block' ? _BLOCK_RAMP : _CHAR_RAMP;

		// Tone adjustments
		const brightAdj = parseInt(dom.brightSlider?.value) || 0;
		const contrastAdj = parseInt(dom.contrastSlider?.value) || 0;
		const bMul = 1 + (brightAdj / 100);
		const cMul = 1 + (contrastAdj / 100);

		// Mono colours
		const monoFg = dom.fgInput?.value || '#00ff00';

		// Compute rows preserving aspect ratio
		const vw = videoEl.videoWidth || 640;
		const vh = videoEl.videoHeight || 480;
		// Characters are ~2x taller than wide
		const ROWS = Math.max(1, Math.round(COLS * (vh / vw) * 0.45));
		_liveCanvas.width = COLS;
		_liveCanvas.height = ROWS;
		_liveCtx.drawImage(videoEl, 0, 0, COLS, ROWS);

		let data;
		try { data = _liveCtx.getImageData(0, 0, COLS, ROWS).data; }
		catch { return; }

		// ── Build output ──
		const useTruecolor = colourMode === 'truecolor' || colourMode === 'palette' || colourMode === 'kmeans';
		let html = '';

		for (let y = 0; y < ROWS; y++) {
			for (let x = 0; x < COLS; x++) {
				const i = (y * COLS + x) * 4;
				let r = data[i], g = data[i + 1], b = data[i + 2];

				// Apply brightness + contrast
				r = Math.max(0, Math.min(255, ((r - 128) * cMul + 128) * bMul));
				g = Math.max(0, Math.min(255, ((g - 128) * cMul + 128) * bMul));
				b = Math.max(0, Math.min(255, ((b - 128) * cMul + 128) * bMul));

				const lum = (r * 0.2126 + g * 0.7152 + b * 0.0722) / 255;
				const ci = Math.min(ramp.length - 1, Math.floor(lum * ramp.length));
				const ch = ramp[ci] === '<' ? '&lt;' : ramp[ci] === '>' ? '&gt;' : ramp[ci] === '&' ? '&amp;' : ramp[ci];

				if (useTruecolor) {
					html += '<span style="color:rgb(' + (r | 0) + ',' + (g | 0) + ',' + (b | 0) + ')">' + ch + '</span>';
				} else {
					// mono — just the character, CSS color handles it
					html += ch;
				}
			}
			html += '\n';
		}

		if (colourMode === 'mono') {
			_liveAsciiEl.style.color = monoFg;
		}
		_liveAsciiEl.innerHTML = html;

		// Auto-fit font size so ASCII fills the container
		const box = containerEl.getBoundingClientRect();
		if (box.width > 0 && box.height > 0 && COLS > 0 && ROWS > 0) {
			// Each character cell: fontW = box.width / COLS, fontH = box.height / ROWS
			const fontW = box.width / (COLS + 1); // +1 for newline spacing
			const fontH = box.height / (ROWS + 1);
			// Use the smaller to maintain aspect, with line-height set to match
			const fontSize = Math.min(fontW * 1.65, fontH); // chars are ~0.6× wide as tall
			_liveAsciiEl.style.fontSize = Math.max(2, fontSize).toFixed(1) + 'px';
			_liveAsciiEl.style.lineHeight = (fontH / fontSize).toFixed(3);
		}
	}

	drawFrame();
}

function stopLiveAscii() {
	if (_liveRafId) { cancelAnimationFrame(_liveRafId); _liveRafId = null; }
	if (_liveAsciiEl) { _liveAsciiEl.remove(); _liveAsciiEl = null; }
	if (_liveCanvas) { _liveCanvas.remove(); _liveCanvas = null; }
	if (_livePipEl) { _livePipEl.srcObject = null; _livePipEl.remove(); _livePipEl = null; }
	_liveCtx = null;
	// Reset container
	dom.previewVideoContainer.style.background = '';
	dom.previewVideoContainer.style.minHeight = '';
	// Restore main video visibility
	dom.previewVideo.style.opacity = '';
	dom.previewVideo.style.position = '';
	dom.previewVideo.style.pointerEvents = '';
	// Remove recording class if present
	dom.previewVideoContainer.classList.remove('webcam-recording');
}

function formatDuration(sec) {
	const m = Math.floor(sec / 60);
	const s = sec % 60;
	return m + ':' + String(s).padStart(2, '0');
}

async function startWebcam() {
	// Request camera + microphone
	let stream;
	try {
		stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
	} catch (err) {
		alert('Could not access webcam: ' + err.message);
		return;
	}

	setState('webcamStream', stream);
	setState('recordedChunks', []);
	setState('mediaRecorder', null);

	// Show live preview — disable loop/controls for live feed
	dom.previewVideo.srcObject = stream;
	dom.previewVideo.muted = true;
	dom.previewVideo.loop = false;
	dom.previewVideo.removeAttribute('controls');
	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.classList.remove('hidden');
	dom.dropZone.classList.add('hidden');
	dom.fileHeader.classList.add('hidden');
	dom.previewTabs.classList.add('hidden');

	// Show webcam bar
	dom.webcamBar.classList.remove('hidden');
	dom.recordStartBtn.disabled = false;
	dom.recordPauseBtn.disabled = true;
	dom.recordPauseBtn.style.display = 'none';
	dom.recordStopBtn.disabled = true;
	dom.recordStopBtn.style.display = 'none';
	dom.recordStatus.textContent = 'Live — click Record to start';
	dom.recordTimer.style.display = 'none';

	await dom.previewVideo.play().catch(() => { });
	// Start live ASCII overlay
	startLiveAscii(dom.previewVideo, dom.previewVideoContainer);
}

function startRecording() {
	if (!state.webcamStream) return;
	// Keep live ASCII running — MediaRecorder captures the raw stream, not the DOM.
	// Add flashing red border to indicate recording.
	dom.previewVideoContainer.classList.add('webcam-recording');

	const chunks = [];
	const mimeType = ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm', 'video/mp4']
		.find(t => MediaRecorder.isTypeSupported(t)) || '';

	const mr = new MediaRecorder(state.webcamStream, mimeType ? { mimeType } : {});
	setState('mediaRecorder', mr);
	setState('recordedChunks', chunks);

	mr.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };

	mr.onstop = async () => {
		const ext = mimeType.includes('mp4') ? 'mp4' : 'webm';
		const blob = new Blob(chunks, { type: mr.mimeType || 'video/webm' });

		// Validate recording file size
		const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB
		if (blob.size > MAX_FILE_SIZE) {
			appendLog(`Recording too large (${(blob.size / 1024 / 1024).toFixed(1)}MB). Maximum: ${(MAX_FILE_SIZE / 1024 / 1024).toFixed(0)}MB`, 'error');
			dom.logArea.classList.add('active');
			dom.recordStatus.textContent = 'Recording too large';
			// Stop webcam tracks and cleanup
			if (state.webcamStream) {
				state.webcamStream.getTracks().forEach(t => t.stop());
				setState('webcamStream', null);
			}
			stopLiveAscii();
			return;
		}

		// Filename: YYMMDDHHMMSS.webm
		const now = new Date();
		const pad = (n) => String(n).padStart(2, '0');
		const filename = String(now.getFullYear()).slice(2) + pad(now.getMonth() + 1) + pad(now.getDate())
			+ pad(now.getHours()) + pad(now.getMinutes()) + pad(now.getSeconds()) + '.' + ext;

		dom.recordStatus.textContent = 'Uploading…';
		dom.recordTimer.style.display = 'none';

		// Stop webcam tracks
		if (state.webcamStream) {
			state.webcamStream.getTracks().forEach(t => t.stop());
			setState('webcamStream', null);
		}
		// Restore video element defaults for playback
		stopLiveAscii();
		dom.previewVideo.srcObject = null;
		dom.previewVideo.muted = true;
		dom.previewVideo.loop = true;
		dom.previewVideo.setAttribute('controls', '');

		try {
			if (isStandalone()) {
				// Standalone mode: use blob URL directly, no server upload
				const blobUrl = URL.createObjectURL(blob);
				setState('blobUrl', blobUrl);
				setState('rawFile', new File([blob], filename, { type: blob.type }));
				setState('videoFileSize', blob.size);

				showFileSelected(filename);
				dom.previewVideo.src = blobUrl;
				dom.previewVideoContainer.classList.remove('hidden');
				dom.previewVideo.classList.remove('hidden');
				dom.previewVideo.load();
				dom.previewVideo.play().catch(() => { });

				await probeFile(state.rawFile);
				dom.webcamBar.classList.add('hidden');
			} else {
				const upRes = await fetch('/api/upload', {
					method: 'POST',
					headers: {
						'Content-Type': 'application/octet-stream',
						'X-Filename': encodeURIComponent(filename),
					},
					body: blob,
				});
				const upData = await upRes.json();
				if (upData.ok && upData.resolvedPath) {
					const blobUrl = URL.createObjectURL(blob);
					setState('blobUrl', blobUrl);
					setState('selectedPath', upData.resolvedPath);
					setState('videoFileSize', blob.size);

					showFileSelected(filename);
					dom.previewVideo.src = blobUrl;
					dom.previewVideoContainer.classList.remove('hidden');
					dom.previewVideo.classList.remove('hidden');
					dom.previewVideo.load();
					dom.previewVideo.play().catch(() => { });

					await probeFile(upData.resolvedPath);
					dom.webcamBar.classList.add('hidden');
				} else if (!upData.ok) {
					dom.recordStatus.textContent = 'Upload failed: ' + (upData.error || 'unknown');
				} else {
					dom.recordStatus.textContent = 'Upload error: server did not return file path';
				}
			}
		} catch (err) {
			dom.recordStatus.textContent = 'Upload error: ' + err.message;
		}

		// Hide webcam bar controls
		dom.recordPauseBtn.style.display = 'none';
		dom.recordStopBtn.style.display = 'none';
		dom.recordStartBtn.disabled = true;
		dom.recordStartBtn.style.display = 'none';
	};

	mr.start(200); // collect data every 200ms

	// Timer
	let elapsed = 0;
	dom.recordTimer.textContent = formatDuration(0);
	dom.recordTimer.style.display = '';
	const timer = setInterval(() => {
		if (state.mediaRecorder && state.mediaRecorder.state === 'recording') {
			elapsed++;
			dom.recordTimer.textContent = formatDuration(elapsed);
		}
	}, 1000);
	setState('recordTimer', timer);

	// Button states
	dom.recordStartBtn.disabled = true;
	dom.recordPauseBtn.disabled = false;
	dom.recordPauseBtn.style.display = '';
	dom.recordPauseBtn.textContent = '⏸ Pause';
	dom.recordStopBtn.disabled = false;
	dom.recordStopBtn.style.display = '';
	dom.recordStatus.textContent = 'Recording…';
}

function stopRecording() {
	if (state.recordTimer) { clearInterval(state.recordTimer); setState('recordTimer', null); }
	if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
		state.mediaRecorder.stop();
	}
}

function togglePause() {
	if (!state.mediaRecorder) return;
	if (state.mediaRecorder.state === 'recording') {
		state.mediaRecorder.pause();
		dom.recordPauseBtn.textContent = '⏯ Resume';
		dom.recordStatus.textContent = 'Paused';
	} else if (state.mediaRecorder.state === 'paused') {
		state.mediaRecorder.resume();
		dom.recordPauseBtn.textContent = '⏸ Pause';
		dom.recordStatus.textContent = 'Recording…';
	}
}

function stopWebcam() {
	stopLiveAscii();
	if (state.recordTimer) { clearInterval(state.recordTimer); setState('recordTimer', null); }
	if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
		state.mediaRecorder.stop();
	}
	if (state.webcamStream) {
		state.webcamStream.getTracks().forEach(t => t.stop());
		setState('webcamStream', null);
	}
	dom.previewVideo.srcObject = null;
	dom.previewVideo.muted = true;
	dom.previewVideo.loop = true;
	dom.previewVideo.setAttribute('controls', '');
	setState('mediaRecorder', null);
	setState('recordedChunks', []);
	dom.webcamBar.classList.add('hidden');
	dom.recordStartBtn.disabled = true;
	dom.recordStartBtn.style.display = '';
	dom.recordPauseBtn.style.display = 'none';
	dom.recordStopBtn.style.display = 'none';
	dom.recordStatus.textContent = 'Ready — click Record to start';
	dom.recordTimer.style.display = 'none';
}

/* ── DOM Init Logic ────────────────────────────────────────── */

// Cleanup on page unload
window.addEventListener('beforeunload', () => {
	if (state.mediaRecorder && state.mediaRecorder.state !== 'inactive') {
		state.mediaRecorder.stop();
	}
	if (state.webcamStream) {
		state.webcamStream.getTracks().forEach(t => t.stop());
	}
});

// Load input files
(async function loadFiles() {
	try {
		if (isStandalone()) {
			// Hide the server-only "pick from input/" dropdown and the "or" divider
			const selectContainer = dom.inputSelect.closest('div');
			if (selectContainer) {
				selectContainer.style.display = 'none';
				// Also hide the "— or —" text that follows
				const nextSibling = selectContainer.nextElementSibling;
				if (nextSibling && nextSibling.textContent.includes('—')) {
					nextSibling.style.display = 'none';
				}
			}
		} else {
			const res = await fetch('/api/files');
			const data = await res.json();
			if (data.ok && data.files.length) {
				data.files.forEach(f => {
					const opt = document.createElement('option');
					opt.value = f;
					opt.textContent = f;
					dom.inputSelect.appendChild(opt);
				});
			}
		}
	} catch { }
})();

// BIND ALL DOM EXPORTS
dom.inputSelect.addEventListener('change', () => {
	if (dom.inputSelect.value) selectFromDropdown(dom.inputSelect.value);
});
dom.changeFileBtn.addEventListener('click', resetFileSelection);

// UI Editables & Sliders
makeEditable(dom.widthVal, dom.widthSlider);
makeEditable(dom.heightVal, dom.heightSlider);
makeEditable(dom.fpsVal, dom.fpsSlider);
makeEditable(dom.depthValEl, dom.depthSlider);
makeEditable(dom.fgThresholdVal, dom.fgThreshold);
makeEditable(dom.brightVal, dom.brightSlider);
makeEditable(dom.contrastVal, dom.contrastSlider);
makeEditable(dom.detailVal, dom.detailSlider);
makeEditable(dom.trimStartVal, dom.trimStartSlider, { step: 0.1 });
makeEditable(dom.trimEndVal, dom.trimEndSlider, { step: 0.1 });
makeEditable(dom.qStepValEl, dom.qStepSlider);

dom.widthSlider.oninput = () => syncResolution('width');
dom.heightSlider.oninput = () => syncResolution('height');
dom.lockAspectChk.onchange = () => {
	if (dom.lockAspectChk.checked) syncResolution('width');
};

dom.fpsSlider.oninput = () => { dom.fpsVal.textContent = dom.fpsSlider.value; updateEstimate(); };
dom.qStepSlider.oninput = () => { dom.qStepValEl.textContent = dom.qStepSlider.value; updateEstimate(); };
dom.depthSlider.oninput = () => { dom.depthValEl.textContent = dom.depthSlider.value; updateEstimate(); };
dom.brightSlider.oninput = () => { dom.brightVal.textContent = dom.brightSlider.value; updateVideoFilters(); };
dom.contrastSlider.oninput = () => { dom.contrastVal.textContent = dom.contrastSlider.value; updateVideoFilters(); };
dom.detailSlider.oninput = () => { dom.detailVal.textContent = dom.detailSlider.value; updateEstimate(); };
dom.fgMode.onchange = updateForegroundFields;
dom.fgThreshold.oninput = () => { dom.fgThresholdVal.textContent = dom.fgThreshold.value; };
dom.fgInput.oninput = () => { dom.fgValEl.textContent = dom.fgInput.value; };
dom.bgInput.oninput = () => { dom.bgValEl.textContent = dom.bgInput.value; };
dom.fgBgInput.oninput = () => { dom.fgBgVal.textContent = dom.fgBgInput.value; };

dom.rawJsToggle.addEventListener('click', () => {
	const nowRaw = dom.rawJsToggle.getAttribute('aria-pressed') !== 'true';
	dom.rawJsToggle.setAttribute('aria-pressed', String(nowRaw));
	dom.showRawJsChk.checked = nowRaw;
	if (dom.tabConvertedBundle.classList.contains('active')) {
		dom.tabConvertedBundle.click(); // re-trigger tab logic
	}
});
dom.fgBackground.onchange = updateForegroundFields;

dom.modeSelect.onchange = () => { updateModeFields(); updateEstimate(); };
dom.charMode.onchange = () => { updateModeFields(); updateEstimate(); };

// Trim bind
dom.trimStartInp.addEventListener('input', () => { syncTrimInputsToSliders(); updateEstimate(); dom.trimStartVal.textContent = parseFloat(dom.trimStartSlider.value).toFixed(1); });
dom.trimEndInp.addEventListener('input', () => { syncTrimInputsToSliders(); updateEstimate(); dom.trimEndVal.textContent = parseFloat(dom.trimEndSlider.value).toFixed(1); });
dom.trimStartSlider.addEventListener('input', () => { syncTrimSlidersToInputs(); updateEstimate(); dom.trimStartVal.textContent = parseFloat(dom.trimStartSlider.value).toFixed(1); });
dom.trimEndSlider.addEventListener('input', () => { syncTrimSlidersToInputs(); updateEstimate(); dom.trimEndVal.textContent = parseFloat(dom.trimEndSlider.value).toFixed(1); });

// Crop binds
dom.toggleCropBtn.addEventListener('click', toggleCrop);
[dom.cropWInp, dom.cropHInp, dom.cropXInp, dom.cropYInp].forEach(el => {
	el.addEventListener('input', syncCropInputsToBox);
});
dom.cropBox.addEventListener('pointerdown', (e) => {
	e.preventDefault();
	const handle = e.target.getAttribute('data-handle');
	setState('dragContext', {
		handle: handle || 'move',
		startX: e.clientX,
		startY: e.clientY,
		startW: dom.cropBox.offsetWidth,
		startH: dom.cropBox.offsetHeight,
		startL: parseFloat(dom.cropBox.style.left) || 0,
		startT: parseFloat(dom.cropBox.style.top) || 0
	});
	document.addEventListener('pointermove', onCropDrag);
	document.addEventListener('pointerup', onCropDragEnd);
});
window.addEventListener('resize', () => {
	if (state.isCropping) syncCropInputsToBox();
});

// Drag bounds
dom.previewContent.addEventListener('dragover', (e) => {
	e.preventDefault();
	dom.dropZone.classList.add('drag-over');
});
dom.previewContent.addEventListener('dragleave', () => {
	dom.dropZone.classList.remove('drag-over');
});
dom.previewContent.addEventListener('drop', (e) => {
	e.preventDefault();
	dom.dropZone.classList.remove('drag-over');
	if (e.dataTransfer.files[0]) handleFile(e.dataTransfer.files[0]);
});
dom.fileInput.addEventListener('change', () => {
	if (dom.fileInput.files[0]) handleFile(dom.fileInput.files[0]);
});

// Swatch preview binds
dom.previewBgBar.addEventListener('click', (e) => {
	const btn = e.target.closest('.swatch-btn');
	if (!btn) return;
	dom.previewBgBar.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
	btn.classList.add('active');
	applyPreviewBg(btn.dataset.bg);
});
dom.previewBgCustom.addEventListener('input', () => {
	dom.previewBgBar.querySelectorAll('.swatch-btn').forEach(b => b.classList.remove('active'));
	applyPreviewBg(dom.previewBgCustom.value);
});
dom.depthSlider.addEventListener('input', updatePaletteSwatches);
updateModeFields();
updateForegroundFields();

// Tab logic binds
dom.tabOriginal.addEventListener('click', () => {
	dom.tabOriginal.classList.add('active');
	dom.tabConvertedGif.classList.remove('active');
	dom.tabConvertedBundle.classList.remove('active');
	dom.previewContent.classList.remove('bundle-active');
	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.classList.remove('hidden');
	dom.previewGif.classList.add('hidden');
	dom.bundleViewer.classList.add('hidden');
	dom.bundleIframe.classList.add('hidden');
	dom.previewVideo.play().catch(() => { });
	updateInfoBar('original');
	dom.resultsArea.classList.remove('active');
	resetPreviewBg();
	// Reset toggle to Live Preview
	if (dom.rawJsToggle) { dom.rawJsToggle.setAttribute('aria-pressed', 'false'); dom.showRawJsChk.checked = false; }
});
dom.tabConvertedGif.addEventListener('click', () => {
	if (!state.convertedGifBlob) return;
	dom.tabConvertedGif.classList.add('active');
	dom.tabOriginal.classList.remove('active');
	dom.tabConvertedBundle.classList.remove('active');
	dom.previewContent.classList.remove('bundle-active');
	dom.previewGif.classList.remove('hidden');
	dom.previewVideoContainer.classList.add('hidden');
	dom.previewVideo.classList.add('hidden');
	dom.cropBox.classList.add('hidden');
	dom.bundleViewer.classList.add('hidden');
	dom.bundleIframe.classList.add('hidden');
	dom.previewVideo.pause();
	updateInfoBar('converted');
	if (state.lastConvertResult) dom.resultsArea.classList.add('active');
	dom.showRawJsBox.classList.add('hidden');
	showPreviewBgBar();
	applyPreviewBg(state.currentPreviewBg);
});
dom.tabConvertedBundle.addEventListener('click', async () => {
	if (!state.convertedBundleUrl) return;
	dom.tabConvertedBundle.classList.add('active');
	dom.tabOriginal.classList.remove('active');
	dom.tabConvertedGif.classList.remove('active');
	dom.previewContent.classList.add('bundle-active');
	dom.previewVideo.classList.add('hidden');
	dom.previewGif.classList.add('hidden');
	dom.previewVideo.pause();
	if (state.lastConvertResult) dom.resultsArea.classList.add('active');
	showPreviewBgBar();
	dom.showRawJsBox.classList.remove('hidden');
	// Sync toggle visual state with current checkbox
	const isRaw = dom.showRawJsChk.checked;
	if (dom.rawJsToggle) dom.rawJsToggle.setAttribute('aria-pressed', String(isRaw));

	if (dom.showRawJsChk.checked) {
		dom.bundleIframe.classList.add('hidden');
		dom.bundleViewer.classList.remove('hidden');
		if (!state.bundleTextCache) {
			try {
				dom.bundleViewer.textContent = 'Loading bundle.js…';
				// Load the actual bundle.js (not demo.html)
				const rawUrl = state.convertedBundleJsUrl || state.convertedBundleUrl;
				const resp = await fetch(rawUrl + '?t=' + Date.now());
				setState('bundleTextCache', await resp.text());
			} catch (err) {
				setState('bundleTextCache', '// Failed to load bundle.js: ' + err.message);
			}
		}
		dom.bundleViewer.textContent = state.bundleTextCache;
	} else {
		dom.bundleViewer.classList.add('hidden');
		dom.bundleIframe.classList.remove('hidden');
		if (dom.bundleIframe.dataset.bundleUrl !== state.convertedBundleUrl) {
			dom.bundleIframe.dataset.bundleUrl = state.convertedBundleUrl;
			dom.bundleIframe.src = state.convertedBundleUrl;
		}
		// Always set onload so bg is applied after the page is ready
		dom.bundleIframe.onload = () => applyPreviewBg(state.currentPreviewBg);
	}
	applyPreviewBg(state.currentPreviewBg);
});

// Action logic
dom.webcamBtn.addEventListener('click', startWebcam);
dom.recordStartBtn.addEventListener('click', startRecording);
dom.recordPauseBtn.addEventListener('click', togglePause);
dom.recordStopBtn.addEventListener('click', stopRecording);

// Web-mode: webcam-only UI; Desktop: full file-processing UI
if (isWebEnvironment()) {
	initWebMode();
} else {
	dom.convertBtn.addEventListener('click', startConvert);
	dom.stopBtn.addEventListener('click', stopConversion);
}
dom.undoBtn.addEventListener('click', () => {
	if (!state.gifHistory.length) return;
	const prev = state.gifHistory.pop();
	if (state.convertedGifBlob) URL.revokeObjectURL(state.convertedGifBlob);
	setState('convertedGifBlob', prev.blobUrl);
	setState('lastConvertResult', prev.result);
	dom.previewGif.src = state.convertedGifBlob;
	updateInfoBar('converted');
	if (state.lastConvertResult) showResults(state.lastConvertResult);
	dom.undoBtn.disabled = state.gifHistory.length === 0;
});

/* ── Web-Only Mode (webcam CTA, no file upload) ───────────── */
function initWebMode() {
	document.body.classList.add('web-mode');

	// --- Hide file upload elements ---
	dom.fileInput.classList.add('hidden');
	dom.inputSelect.closest('div').style.display = 'none';
	// Hide the "— or —" divider between dropdown and webcam button
	const orDividers = dom.dropZone.querySelectorAll('div');
	orDividers.forEach(d => {
		if (d.textContent.trim() === '— or —') d.style.display = 'none';
	});

	// --- Re-skin drop zone as webcam CTA ---
	const iconEl = dom.dropZone.querySelector('.icon');
	const labelEls = dom.dropZone.querySelectorAll('.label');
	if (iconEl) iconEl.textContent = '📷';
	if (labelEls[0]) labelEls[0].textContent = 'Click anywhere to activate your webcam';
	if (labelEls[1]) labelEls[1].textContent = 'Live ASCII preview — record & convert';
	// Hide the separate webcam button (drop zone IS the trigger now)
	dom.webcamBtn.classList.add('hidden');

	// Bind the entire drop zone to start the webcam
	dom.dropZone.addEventListener('click', (e) => {
		// Prevent the hidden file input from intercepting
		if (e.target === dom.fileInput) { e.preventDefault(); return; }
		handleWebcamActivation();
	});

	// --- Convert button → Open GitHub ---
	dom.convertBtn.textContent = '⭐ Open GitHub';
	dom.convertBtn.disabled = false;
	dom.convertBtn.addEventListener('click', () => {
		window.open('https://github.com/iman-hussain/ASCII-fy', '_blank');
	});

	// Prevent other code paths (probeFile, resetFileSelection) from disabling our GitHub button
	const _btnObserver = new MutationObserver(() => {
		if (dom.convertBtn.disabled) dom.convertBtn.disabled = false;
	});
	_btnObserver.observe(dom.convertBtn, { attributes: true, attributeFilter: ['disabled'] });

	// Stop button is unused in web mode
	dom.stopBtn.classList.add('hidden');

	// --- Hide web-specific features that don't function on web ---
	// Crop button (requires file processing not available in web)
	if (dom.toggleCropBtn) dom.toggleCropBtn.parentElement.closest('.row').style.display = 'none';
	
	// Recording controls (not available in browser context)
	if (dom.recordStartBtn) dom.recordStartBtn.style.display = 'none';
	if (dom.recordPauseBtn) dom.recordPauseBtn.style.display = 'none';
	if (dom.recordStopBtn) dom.recordStopBtn.style.display = 'none';
	if (dom.recordStatus) dom.recordStatus.style.display = 'none';
	if (dom.recordTimer) dom.recordTimer.style.display = 'none';
	
	// Skip GIF checkbox (GIF generation not configurable on web)
	if (dom.skipGif) dom.skipGif.closest('.row').style.display = 'none';
	
	// Lock aspect ratio (not applicable for live webcam in web)
	if (dom.lockAspectChk) dom.lockAspectChk.closest('.row').style.display = 'none';
	
	// Estimated file sizes (not applicable for web streaming)
	if (dom.estimateArea) dom.estimateArea.style.display = 'none';
	
	// Subject isolation / foreground mode (requires WASM model loading not suitable for web)
	if (dom.fgIsolationRow) dom.fgIsolationRow.style.display = 'none';

	// Disable drag-and-drop file handling in web mode
	dom.previewContent.addEventListener('drop', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
	dom.previewContent.addEventListener('dragover', (e) => { e.preventDefault(); e.stopPropagation(); }, true);
}

/** Attempt to start webcam with user-friendly error handling */
async function handleWebcamActivation() {
	const iconEl = dom.dropZone.querySelector('.icon');
	const labelEls = dom.dropZone.querySelectorAll('.label');

	// Reset any previous error state (supports retry)
	if (iconEl) iconEl.textContent = '📷';
	if (labelEls[0]) {
		labelEls[0].textContent = 'Activating webcam…';
		labelEls[0].style.color = '';
	}
	if (labelEls[1]) labelEls[1].textContent = '';

	// Check for camera API support
	if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
		if (iconEl) iconEl.textContent = '⚠️';
		if (labelEls[0]) {
			labelEls[0].textContent = 'Camera not supported in this browser';
			labelEls[0].style.color = 'var(--danger)';
		}
		if (labelEls[1]) labelEls[1].textContent = 'Try Chrome, Firefox, or Edge on a device with a camera';
		return;
	}

	try {
		// Briefly test camera access before handing off to startWebcam()
		const testStream = await navigator.mediaDevices.getUserMedia({ video: true });
		testStream.getTracks().forEach(t => t.stop());
		startWebcam();
	} catch (err) {
		if (iconEl) iconEl.textContent = '🚫';
		if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
			if (labelEls[0]) {
				labelEls[0].textContent = 'Camera access was denied';
				labelEls[0].style.color = 'var(--danger)';
			}
			if (labelEls[1]) labelEls[1].textContent = 'Enable camera permissions in your browser settings, then click here to retry';
		} else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
			if (labelEls[0]) {
				labelEls[0].textContent = 'No camera detected';
				labelEls[0].style.color = 'var(--danger)';
			}
			if (labelEls[1]) labelEls[1].textContent = 'Connect a webcam and click here to retry';
		} else {
			if (labelEls[0]) {
				labelEls[0].textContent = 'Could not access camera: ' + err.message;
				labelEls[0].style.color = 'var(--danger)';
			}
			if (labelEls[1]) labelEls[1].textContent = 'Click to retry';
		}
		// Allow retry — clicking the drop zone will call this function again
	}
}
