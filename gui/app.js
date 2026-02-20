import { dom } from './js/dom.js';
import { state, resetState, setState } from './js/state.js';
import { formatBytes, appendLog } from './js/utils.js';
import { startConvert, stopConversion } from './js/api.js';
import {
	updateEstimate, makeEditable, updateModeFields,
	updateForegroundFields, applyPreviewBg, resetPreviewBg,
	showPreviewBgBar, updatePaletteSwatches, updateVideoFilters
} from './js/ui.js';
import {
	toggleCrop, syncCropInputsToBox, syncTrimInputsToSliders,
	syncTrimSlidersToInputs, onCropDrag, onCropDragEnd
} from './js/crop-trim.js';

/* ── Core File Initialization ────────────────────────────────────────── */
export async function probeFile(path) {
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
			return;
		}
		clampSlidersToSource();
		updateInfoBar('original');
		updateEstimate();
		dom.convertBtn.disabled = false;
	} catch {
		setState('videoMeta', null);
	}
}

async function selectFromDropdown(name) {
	resetState();
	showFileSelected(name);
	setState('selectedPath', name);
	await probeFile(name);

	if (!state.selectedPath) return;
	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.src = '/api/video?path=' + encodeURIComponent(state.selectedPath);
	dom.previewVideo.classList.remove('hidden');
	dom.previewVideo.play().catch(() => { });
	dom.dropZone.classList.add('hidden');
	syncTrimSlidersToInputs();
}

async function handleFile(file, forceUpload) {
	resetState();
	setState('videoFileSize', file.size);
	showFileSelected(file.name);

	let blobUrl = URL.createObjectURL(file);
	setState('blobUrl', blobUrl);
	dom.previewVideo.src = blobUrl;
	dom.previewVideoContainer.classList.remove('hidden');
	dom.previewVideo.classList.remove('hidden');
	dom.previewVideo.load();
	dom.previewVideo.play().catch(() => { });
	dom.dropZone.classList.add('hidden');

	let resolved = false;
	if (!forceUpload) try {
		const probeRes = await fetch('/api/probe', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path: file.name }),
		});
		const probeData = await probeRes.json();
		if (probeData.ok && probeData.resolvedPath) {
			setState('selectedPath', probeData.resolvedPath);
			setState('videoMeta', probeData.meta || null);
			if (probeData.fileSize) setState('videoFileSize', probeData.fileSize);
			clampSlidersToSource();
			updateInfoBar('original');
			updateEstimate();
			dom.convertBtn.disabled = false;
			resolved = true;
		}
	} catch { }

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
			if (upData.ok) {
				setState('selectedPath', upData.resolvedPath);
				await probeFile(state.selectedPath);
			} else {
				appendLog('Upload failed: ' + (upData.error || 'Unknown error'), 'error');
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
	dom.previewFrameBtn.disabled = true;
	dom.inputSelect.value = '';
	dom.previewVideo.src = '';
	dom.tabOriginal.classList.add('active');
	dom.tabConvertedGif.classList.remove('active');
	dom.tabConvertedGif.disabled = true;
	dom.tabConvertedBundle.classList.remove('active');
	dom.tabConvertedBundle.disabled = true;
	dom.tabFramePreview.classList.remove('active');
	dom.tabFramePreview.disabled = true;
	dom.framePreview.classList.add('hidden');
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
		dom.trimEndSlider.value = state.videoMeta.duration;
		dom.trimStartInp.value = 0;
		dom.trimEndInp.value = state.videoMeta.duration;
		syncTrimSlidersToInputs();
	}
}

function resetSliderMaxes() {
	dom.widthSlider.max = 200;
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
		if (d.gifSize) parts.push(formatBytes(d.gifSize) + ' GIF');
		dom.infoSize.textContent = parts.join(' · ') || '—';
		// Clear any stale aspect-ratio override — the GIF pixel dimensions are already correct
		dom.previewGif.style.aspectRatio = '';
	} else if (state.videoMeta) {
		dom.infoBar.classList.remove('hidden');
		if (state.videoMeta.width && state.videoMeta.height) dom.infoDims.textContent = state.videoMeta.width + '×' + state.videoMeta.height;
		if (state.videoMeta.fps) dom.infoFps.textContent = state.videoMeta.fps.toFixed(1);
		if (state.videoMeta.duration && state.videoMeta.fps) {
			dom.infoFrames.textContent = Math.round(state.videoMeta.duration * state.videoMeta.fps).toLocaleString();
		}
		dom.infoSize.textContent = state.videoFileSize ? formatBytes(state.videoFileSize) : '—';
		if (state.videoMeta.width && state.videoMeta.height) dom.previewVideo.style.aspectRatio = state.videoMeta.width + ' / ' + state.videoMeta.height;
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
	if (d.htmlPath) addAction('Open Player', d.htmlPath);
	if (d.gifPath) addAction('Open GIF', d.gifPath);
	if (d.outputDir) addAction('Show Folder', d.outputDir);
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

function stopWebcam() {
	if (state.webcamStream) {
		state.webcamStream.getTracks().forEach(t => t.stop());
		setState('webcamStream', null);
	}
	dom.previewVideo.srcObject = null;
	setState('mediaRecorder', null);
	setState('recordedChunks', []);
	if (state.recordTimer) { clearInterval(state.recordTimer); setState('recordTimer', null); }
	dom.webcamBar.classList.add('hidden');
	dom.recordStartBtn.disabled = true;
	dom.recordStopBtn.disabled = true;
	dom.recordStatus.textContent = 'Ready';
}

/* ── DOM Init Logic ────────────────────────────────────────── */

// Load input files
(async function loadFiles() {
	try {
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
	} catch { }
})();

// BIND ALL DOM EXPORTS
dom.inputSelect.addEventListener('change', () => {
	if (dom.inputSelect.value) selectFromDropdown(dom.inputSelect.value);
});
dom.changeFileBtn.addEventListener('click', resetFileSelection);

// UI Editables & Sliders
makeEditable(dom.widthVal, dom.widthSlider);
makeEditable(dom.fpsVal, dom.fpsSlider);
makeEditable(dom.depthValEl, dom.depthSlider);
makeEditable(dom.fgThresholdVal, dom.fgThreshold);
makeEditable(dom.brightVal, dom.brightSlider);
makeEditable(dom.contrastVal, dom.contrastSlider);

dom.widthSlider.oninput = () => { dom.widthVal.textContent = dom.widthSlider.value; updateEstimate(); };
dom.fpsSlider.oninput = () => { dom.fpsVal.textContent = dom.fpsSlider.value; updateEstimate(); };
dom.depthSlider.oninput = () => { dom.depthValEl.textContent = dom.depthSlider.value; updateEstimate(); };
dom.brightSlider.oninput = () => { dom.brightVal.textContent = dom.brightSlider.value; updateVideoFilters(); };
dom.contrastSlider.oninput = () => { dom.contrastVal.textContent = dom.contrastSlider.value; updateVideoFilters(); };
dom.fgThreshold.oninput = () => { dom.fgThresholdVal.textContent = dom.fgThreshold.value; };
dom.fgInput.oninput = () => { dom.fgValEl.textContent = dom.fgInput.value; };
dom.bgInput.oninput = () => { dom.bgValEl.textContent = dom.bgInput.value; };
dom.fgBgInput.oninput = () => { dom.fgBgVal.textContent = dom.fgBgInput.value; };

dom.fgEnable.onchange = updateForegroundFields;
dom.fgBackground.onchange = updateForegroundFields;
dom.fgMode.onchange = updateForegroundFields;

dom.modeSelect.onchange = () => { updateModeFields(); updateEstimate(); };

// Trim bind
dom.trimStartInp.addEventListener('input', () => { syncTrimInputsToSliders(); updateEstimate(); });
dom.trimEndInp.addEventListener('input', () => { syncTrimInputsToSliders(); updateEstimate(); });
dom.trimStartSlider.addEventListener('input', () => { syncTrimSlidersToInputs(); updateEstimate(); });
dom.trimEndSlider.addEventListener('input', () => { syncTrimSlidersToInputs(); updateEstimate(); });

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
if (dom.paletteSelect) dom.paletteSelect.addEventListener('change', updatePaletteSwatches);
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

	if (dom.showRawJsChk.checked) {
		dom.bundleIframe.classList.add('hidden');
		dom.bundleViewer.classList.remove('hidden');
		if (!state.bundleTextCache) {
			try {
				dom.bundleViewer.textContent = 'Loading bundle.js…';
				const resp = await fetch(state.convertedBundleUrl + '?t=' + Date.now());
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
dom.convertBtn.addEventListener('click', startConvert);
dom.stopBtn.addEventListener('click', stopConversion);
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
