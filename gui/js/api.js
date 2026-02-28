import { dom } from './dom.js';
import { state, setState } from './state.js';
import { appendLog, formatBytes } from './utils.js';
import { estimateBundleBase, updateEstimate } from './ui.js';
import { getActiveCrop } from './crop-trim.js';
import { showResults, updateTabSizes } from '../app.js';

// We will define evtSource conditionally below to prevent 404s on GitHub Pages.
export let evtSource = null;

// --- WASM Worker Setup ---
let wasmWorker = null;

function initWasmWorker() {
	if (!wasmWorker) {
		wasmWorker = new Worker('/js/wasm/worker.js', { type: 'module' });
		wasmWorker.onmessage = handleWasmMessage;
		wasmWorker.onerror = (e) => {
			console.error('[ASCII-fy] Worker error:', e.message, e.filename, e.lineno);
			appendLog('Worker error: ' + (e.message || 'Unknown error'), 'error');
			endConversionUI();
		};
	}
	return wasmWorker;
}

export function isStandalone() {
	// If we're on localhost but NOT port 3000 (e.g. npx serve), or on GitHub Pages, we are standalone.
	// For this specific setup, we'll cleanly check if the backend API exists.
	// But as a rapid check:
	const standalone = window.location.hostname !== 'localhost' && window.location.hostname !== '127.0.0.1';
	console.log(`[ASCII-fy] Standalone mode: ${standalone} (hostname: ${window.location.hostname})`);
	return standalone;
}

export async function stopConversion() {
	if (isStandalone()) {
		if (wasmWorker) wasmWorker.postMessage({ type: 'ABORT' });
	} else {
		try { await fetch('/api/abort', { method: 'POST' }); } catch { }
	}
	dom.stopBtn.disabled = true;
	dom.stopBtn.textContent = 'Stopping…';
}

export async function startConvert() {
	if (!state.selectedPath) return;
	dom.convertBtn.style.display = 'none';
	dom.stopBtn.style.display = '';
	dom.stopBtn.disabled = false;
	dom.stopBtn.textContent = '■ Stop';
	setState('isConverting', true);
	setState('conversionStartTime', Date.now());

	dom.progressArea.classList.add('active');
	dom.progressFill.style.width = '0%';
	dom.progressLabel.textContent = 'Starting…';
	dom.logArea.classList.add('active');
	dom.logBox.innerHTML = '';
	dom.resultsArea.classList.remove('active');

	const mode = dom.modeSelect.value;
	const opts = {
		inputPath: state.selectedPath,
		width: parseInt(dom.widthSlider.value),
		height: parseInt(dom.heightSlider.value),
		fps: parseInt(dom.fpsSlider.value),
		mode,
		charMode: dom.charMode?.value || 'ascii',
		depth: parseInt(dom.depthSlider.value),
		palette: dom.paletteSelect?.value || 'grayscale',
		fg: dom.fgInput.value,
		bg: dom.bgInput.value,
		playerBg: mode === 'mono' ? undefined : 'auto',
		start: parseFloat(dom.trimStartInp.value) || undefined,
		end: parseFloat(dom.trimEndInp.value) || undefined,
		customTone: {
			brightness: parseInt(dom.brightSlider?.value) || 0,
			contrast: parseInt(dom.contrastSlider?.value) || 0
		},
		skipGif: dom.skipGif?.checked,
		detail: parseInt(dom.detailSlider?.value ?? 100),
		qStep: parseInt(dom.qStepSlider?.value ?? 24)
	};

	setState('lastConvertOptions', {
		mode,
		width: opts.width,
		depth: opts.depth,
		qStep: opts.qStep,
		detail: opts.detail
	});

	const activeCrop = getActiveCrop();
	if (activeCrop) opts.crop = activeCrop;

	if (dom.fgMode.value !== 'none') {
		opts.foreground = {
			mode: dom.fgMode.value,
			background: dom.fgBackground.value,
			threshold: parseInt(dom.fgThreshold.value),
			bg: dom.fgBgInput.value,
		};
	}

	if (isStandalone()) {
		// --- WASM Mode ---
		appendLog("Initializing WebAssembly engine...", "info");
		const worker = initWasmWorker();

		// The web converter needs the actual File object, which we kept in state.
		// If we don't have it (e.g. dragged file isn't stored properly), this will fail.
		// *We must ensure `app.js` stores the raw File object in state.*
		if (!state.rawFile) {
			appendLog("Standalone mode requires dragging/dropping a local file.", "error");
			endConversionUI();
			return;
		}

		worker.postMessage({
			type: 'CONVERT',
			payload: { file: state.rawFile, options: opts }
		});

	} else {
		// --- Local API Mode ---
		try {
			await fetch('/api/convert', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(opts),
			});
		} catch (err) {
			appendLog('Fetch error: ' + err.message, 'error');
			endConversionUI();
		}
	}
}

function endConversionUI() {
	setState('isConverting', false);
	setState('conversionStartTime', null);
	dom.convertBtn.style.display = '';
	dom.stopBtn.style.display = 'none';
	dom.convertBtn.disabled = false;
}

// --- WASM Worker Message Handler ---
function handleWasmMessage(e) {
	const { type, index, chars, result, error, info } = e.data;

	if (type === 'PROBE_SUCCESS') {
		// Handled by promises in probeVideo hybrid wrapper
		const evt = new CustomEvent('wasm_probe', { detail: { ok: true, meta: info } });
		window.dispatchEvent(evt);
	}
	if (type === 'PROBE_ERROR') {
		const evt = new CustomEvent('wasm_probe', { detail: { ok: false, error } });
		window.dispatchEvent(evt);
	}

	if (type === 'PROGRESS') {
		const totalFrames = state.videoMeta?.frames || (state.videoMeta?.duration * state.lastConvertOptions?.fps) || 100;
		const frame = index + 1;
		const percent = Math.min(100, Math.round((frame / totalFrames) * 100));

		dom.progressFill.style.width = percent + '%';
		let label = 'Frame ' + frame + ' (~' + percent + '%)';

		if (state.conversionStartTime && frame > 1) {
			const elapsed = (Date.now() - state.conversionStartTime) / 1000;
			const perFrame = elapsed / (frame - 1);
			const remaining = Math.max(0, (totalFrames - frame) * perFrame);
			if (remaining < 60) {
				label += ' — ~' + Math.ceil(remaining) + 's left';
			} else {
				const m = Math.floor(remaining / 60);
				const s = Math.ceil(remaining % 60);
				label += ' — ~' + m + 'm ' + s + 's left';
			}
		}
		dom.progressLabel.textContent = label;
	}

	if (type === 'STATUS') {
		const { message } = e.data;
		dom.progressLabel.textContent = message;
	}

	if (type === 'CONVERT_SUCCESS') {
		appendLog('WASM conversion finished successfully!', 'success');

		const d = {
			gifBlob: null,
			gifUrl: null,
			bundleJSStr: null,
			demoHTMLStr: null,
			bundleBlob: null,
			bundleUrl: null,
		};

		if (result.gif && result.gif.buffer) {
			d.gifBlob = new Blob([result.gif.buffer], { type: 'image/gif' });
			d.gifUrl = URL.createObjectURL(d.gifBlob);
		}

		if (result.bundle && result.bundle.demoHTML) {
			const htmlStr = result.bundle.demoHTML.replace(
				'<script src="bundle.js"></script>',
				'<script>\n' + result.bundle.bundleJS + '\n</script>'
			);
			d.bundleBlob = new Blob([htmlStr], { type: 'text/html' });
			d.bundleUrl = URL.createObjectURL(d.bundleBlob);
		}

		showResults(d);
		endConversionUI();
	}

	if (type === 'CONVERT_ERROR') {
		appendLog('WASM Error: ' + error, 'error');
		dom.progressFill.style.background = 'var(--danger)';
		dom.progressLabel.textContent = 'Conversion failed';
		setTimeout(() => { dom.progressFill.style.background = ''; }, 4000);
		endConversionUI();
	}

	if (type === 'CONVERT_ABORTED') {
		appendLog('Conversion aborted.', 'error');
		endConversionUI();
	}
}

// --- Local Node.js API Event Handlers ---
if (!isStandalone()) {
	evtSource = new EventSource('/events');

	evtSource.onerror = (e) => {
		console.error('[ASCII-fy] EventSource error:', e);
		appendLog('Connection lost. Check that conversion started.', 'error');
	};

	evtSource.addEventListener('progress', (e) => {
		const d = JSON.parse(e.data);

		if (d.phase === 'gif') {
			dom.progressLabel.textContent = 'Encoding GIF... Please wait';
			return;
		}
		if (d.phase === 'bundle') {
			dom.progressLabel.textContent = 'Packaging Bundle... Please wait';
			return;
		}

		if (d.percent != null) {
			dom.progressFill.style.width = d.percent + '%';
			let label = 'Frame ' + d.frame + '/' + d.total + ' (' + d.percent + '%)';

			if (state.conversionStartTime && d.frame > 1 && d.total) {
				const elapsed = (Date.now() - state.conversionStartTime) / 1000;
				const perFrame = elapsed / (d.frame - 1);
				const remaining = Math.max(0, (d.total - d.frame) * perFrame);
				if (remaining < 60) {
					label += ' — ~' + Math.ceil(remaining) + 's left';
				} else {
					const m = Math.floor(remaining / 60);
					const s = Math.ceil(remaining % 60);
					label += ' — ~' + m + 'm ' + s + 's left';
				}
			}
			dom.progressLabel.textContent = label;
		} else {
			dom.progressLabel.textContent = 'Frame ' + d.frame + '…';
		}
	});

	evtSource.addEventListener('log', (e) => {
		appendLog(JSON.parse(e.data).msg);
	});

	evtSource.addEventListener('done', async (e) => {
		const d = JSON.parse(e.data);
		if (d.ok) {
			dom.progressFill.style.width = '100%';
			dom.progressLabel.textContent = 'Done!';
			appendLog('Conversion complete!', 'success');

			setState('lastConvertResult', d);
			setState('convertedBundleUrl', d.htmlUrl || null);  // Load the HTML player in iframe
			setState('convertedBundleJsUrl', d.bundleUrl || null); // Raw bundle.js for text viewer
			setState('bundleTextCache', null);
			dom.bundleIframe.src = 'about:blank';
			dom.bundleIframe.removeAttribute('srcdoc');
			dom.bundleIframe.dataset.bundleUrl = '';
			dom.previewTabs.classList.remove('hidden');
			dom.tabConvertedBundle.disabled = !state.convertedBundleUrl;

			if (d.gifUrl) {
				if (state.convertedGifBlob && state.lastConvertResult) {
					state.gifHistory.push({ blobUrl: state.convertedGifBlob, result: state.lastConvertResult });
				}
				try {
					const resp = await fetch(d.gifUrl + '?t=' + Date.now());
					const blob = await resp.blob();
					setState('convertedGifBlob', URL.createObjectURL(blob));
				} catch {
					setState('convertedGifBlob', d.gifUrl);
				}

				setState('convertedGifUrl', d.gifUrl);
				dom.previewGif.src = state.convertedGifBlob;
				dom.tabConvertedGif.disabled = false;
			}

			if (state.lastConvertOptions && d.bundleSize && (d.totalFrames || d.frames)) {
				const base = estimateBundleBase({
					w: d.width,
					h: d.height,
					frames: d.totalFrames || d.frames,
					mode: state.lastConvertOptions.mode,
					depth: state.lastConvertOptions.depth,
					qStep: state.lastConvertOptions.qStep,
					detail: state.lastConvertOptions.detail
				});
				if (base > 0) {
					const ratio = d.bundleSize / base;
					setState('estimateScale', Math.max(0.5, Math.min(4, ratio)));
					updateEstimate();
				}
			}

			dom.undoBtn.classList.toggle('hidden', state.gifHistory.length === 0);
			dom.undoBtn.disabled = state.gifHistory.length === 0;

			showResults(d);
			updateTabSizes();

			if (!dom.tabConvertedGif.disabled) {
				dom.tabConvertedGif.click();
			} else if (!dom.tabConvertedBundle.disabled) {
				dom.tabConvertedBundle.click();
			}
		} else {
			appendLog('Error: ' + d.error, 'error');
			dom.progressFill.style.width = '100%';
			dom.progressFill.style.background = 'var(--danger)';
			dom.progressLabel.textContent = 'Conversion failed';
			setTimeout(() => { dom.progressFill.style.background = ''; }, 4000);
		}
		endConversionUI();
	});
}

