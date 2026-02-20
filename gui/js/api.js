import { dom } from './dom.js';
import { state, setState } from './state.js';
import { appendLog, formatBytes } from './utils.js';
import { estimateBundleBase, updateEstimate } from './ui.js';
import { getActiveCrop } from './crop-trim.js';
import { showResults, updateTabSizes } from '../app.js';

export const evtSource = new EventSource('/events');

export async function stopConversion() {
	try { await fetch('/api/abort', { method: 'POST' }); } catch { }
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
			brightness: parseInt(dom.brightSlider.value),
			contrast: parseInt(dom.contrastSlider.value)
		},
		skipGif: dom.skipGif?.checked,
	};

	setState('lastConvertOptions', { mode, width: opts.width });

	const activeCrop = getActiveCrop();
	if (activeCrop) opts.crop = activeCrop;

	if (dom.fgEnable.checked) {
		opts.foreground = {
			mode: dom.fgMode.value,
			background: dom.fgBackground.value,
			threshold: parseInt(dom.fgThreshold.value),
			bg: dom.fgBgInput.value,
		};
	}

	try {
		await fetch('/api/convert', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(opts),
		});
	} catch (err) {
		appendLog('Fetch error: ' + err.message, 'error');
		setState('isConverting', false);
		setState('conversionStartTime', null);
		dom.convertBtn.style.display = '';
		dom.stopBtn.style.display = 'none';
		dom.convertBtn.disabled = false;
	}
}

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
		setState('convertedBundleUrl', d.htmlUrl || null);  // Load the HTML player, not raw .js
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
	setState('isConverting', false);
	setState('conversionStartTime', null);
	dom.convertBtn.style.display = '';
	dom.stopBtn.style.display = 'none';
	dom.convertBtn.disabled = false;
});
