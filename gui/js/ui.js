import { dom } from './dom.js';
import { state, setState } from './state.js';
import { formatBytes } from './utils.js';
import { startConvert, stopConversion } from './api.js';

/* ── Estimate bundle size ──────────────────────────── */
export function estimateBundleBase({ w, h, frames, mode, depth = 16, qStep = 24, detail = 100 }) {
	let bpc = 0.5; // default truecolor

	// Detail adds up to a 10% variance (less detail = flatter image = better compression)
	const detailFactor = 0.9 + (detail / 1000);
	// Quantise scales the size significantly
	const qFactor = Math.max(0.1, 1 - (qStep / 128));

	if (mode === 'mono') {
		bpc = 0.12;
	} else if (mode === 'palette' || mode === 'kmeans' || mode === 'grayscale') {
		const colourFactor = Math.log2(Math.max(2, depth)) / 8; // scales with depth
		bpc = 0.4 * colourFactor * qFactor;
	} else if (mode === 'truecolor') {
		bpc = 0.5 * qFactor;
	}

	return Math.round(w * h * frames * bpc * detailFactor * 0.75 + 18000);
}

export function updateResolution() {
	if (!dom.widthVal || !dom.widthSlider || !dom.heightVal || !dom.heightSlider) return;
	dom.widthVal.textContent = dom.widthSlider.value;
	dom.heightVal.textContent = dom.heightSlider.value;
	updateEstimate();
}

export function updateEstimate() {
	if (!dom.widthSlider || !dom.heightSlider || !dom.fpsSlider || !dom.modeSelect) return;

	const w = parseInt(dom.widthSlider.value);
	const h = parseInt(dom.heightSlider.value);
	const fps = parseInt(dom.fpsSlider.value);
	const mode = dom.modeSelect.value;
	const depth = parseInt(dom.depthSlider?.value) || 16;
	const qStep = parseInt(dom.qStepSlider?.value) || 24;
	const detail = parseInt(dom.detailSlider?.value) || 100;

	// Default to a typical 10s video if no meta is loaded so that sliders update instantly anyway
	const dur = state.videoMeta ? (state.videoMeta.duration || 10) : 10;
	const trimS = parseFloat(dom.trimStartInp?.value) || 0;
	const trimE = parseFloat(dom.trimEndInp?.value) || dur;
	const effDur = Math.max(0.5, Math.min(trimE, dur) - trimS);
	const frames = Math.max(1, Math.round(effDur * fps));

	const base = estimateBundleBase({ w, h, frames, mode, depth, qStep, detail });
	const est = Math.round(base * state.estimateScale);

	if (dom.estimateArea) dom.estimateArea.classList.remove('hidden');
	if (dom.estimateVal) dom.estimateVal.textContent = '~' + formatBytes(est);
	// GIF is pixel-based (CELL_W=6, CELL_H=8 per char) and uncompressed frames —
	// typically ~4-6x larger than the binary bundle. Use 5x as a conservative estimate.
	const gifEst = est * 5;
	const gifEl = document.getElementById('estimateGifVal');
	if (gifEl) gifEl.textContent = '~' + formatBytes(gifEst);
}

/* ── Editable slider values (click to type) ─────────── */
export function makeEditable(spanEl, sliderEl, opts = {}) {
	if (!spanEl || !sliderEl) return;
	spanEl.addEventListener('click', () => {
		if (spanEl.querySelector('input')) return;
		const cur = sliderEl.value;
		const inp = document.createElement('input');
		inp.type = 'number';
		inp.className = 'range-value-input';
		inp.value = cur;
		inp.min = opts.min ?? sliderEl.min;
		inp.max = opts.max ?? sliderEl.max;
		inp.step = sliderEl.step || 1;
		spanEl.textContent = '';
		spanEl.appendChild(inp);
		inp.focus();
		inp.select();
		const commit = () => {
			let v = parseInt(inp.value);
			const lo = parseInt(inp.min), hi = parseInt(inp.max);
			if (isNaN(v)) v = parseInt(cur);
			v = Math.max(lo, Math.min(hi, v));
			sliderEl.value = v;
			spanEl.textContent = v;
			sliderEl.dispatchEvent(new Event('input'));
		};
		inp.addEventListener('blur', commit);
		inp.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') { e.preventDefault(); inp.blur(); }
			if (e.key === 'Escape') { spanEl.textContent = cur; }
		});
	});
}

export function updateVideoFilters() {
	if (!dom.previewVideo || !dom.previewGif) return;

	const live = dom.livePreview?.checked ?? true;
	if (!live) {
		dom.previewVideo.style.filter = '';
		dom.previewGif.style.filter = '';
		return;
	}
	const brightness = parseInt(dom.brightSlider?.value) || 0;
	const contrast = parseInt(dom.contrastSlider?.value) || 0;
	// Map our -100 to 100 range logically into CSS 0 to 2 filter numbers, preserving 0 = 1.0 (neutral) natively mapped below:
	const bCss = 1 + (brightness / 100);
	const cCss = 1 + (contrast / 100);
	const filterStr = `brightness(${Math.max(0, bCss)}) contrast(${Math.max(0, cCss)})`;
	dom.previewVideo.style.filter = filterStr;
	dom.previewGif.style.filter = filterStr;
}

export function updateModeFields() {
	const m = dom.modeSelect.value;

	// Sub-options container is visible for all modes (each has at least one sub-param)
	dom.colourSubOptions.classList.remove('hidden');

	dom.qStepRow.classList.toggle('hidden', m !== 'truecolor');
	dom.paletteRow.classList.toggle('hidden', m !== 'palette');
	dom.depthRow.classList.toggle('hidden', m !== 'palette' && m !== 'kmeans' && m !== 'grayscale');
	dom.monoFgRow.classList.toggle('hidden', m !== 'mono');
	dom.monoBgRow.classList.toggle('hidden', m !== 'mono');

	if (m === 'palette') updatePaletteSwatches();
	else dom.paletteSwatch.innerHTML = '';

	// Outline only is only for ASCII mode
	updateCharModeFields();
}

export function updateCharModeFields() {
	// Detail slider applies to both ascii and block modes — always visible
}

export function updateForegroundFields() {
	const mode = dom.fgMode.value;
	const enabled = mode !== 'none';
	dom.fgSubOptions.classList.toggle('hidden', !enabled);
	dom.fgThresholdRow.classList.toggle('hidden', !enabled);
	const showBg = enabled && dom.fgBackground.value === 'solid';
	dom.fgBgRow.classList.toggle('hidden', !showBg);

	if (mode === 'ml') {
		dom.fgThresholdLabel.textContent = 'Confidence';
		dom.fgThreshold.min = 10;
		dom.fgThreshold.max = 90;
		if (parseInt(dom.fgThreshold.value) < 30) {
			dom.fgThreshold.value = 50;
			dom.fgThresholdVal.textContent = '50';
		}
	} else {
		dom.fgThresholdLabel.textContent = 'Sensitivity';
		dom.fgThreshold.min = 5;
		dom.fgThreshold.max = 80;
	}
}

/* ── Preview background colour ─────────────────────── */
const CHECKERBOARD_CSS = 'repeating-conic-gradient(#808080 0% 25%, #c0c0c0 0% 50%) 50% / 16px 16px';

export function applyPreviewBg(bg) {
	setState('currentPreviewBg', bg);
	const bgCss = bg === 'checkerboard' ? CHECKERBOARD_CSS : bg;
	const bgMsg = bg === 'checkerboard' ? '#111' : bg;
	// Apply to all preview containers
	dom.previewGif.style.background = bgCss;
	dom.previewContent.style.background = bgCss;
	dom.bundleViewer.style.background = bgCss;
	// For the iframe, postMessage is the only way to set background inside
	// (the iframe's own HTML controls its background)
	const sendBgMsg = () => {
		try { dom.bundleIframe.contentWindow.postMessage({ type: 'set-bg', color: bgMsg }, '*'); } catch { }
	};
	if (!dom.bundleIframe.classList.contains('hidden')) {
		// If already loaded, send immediately; also hook onload in case still loading
		dom.bundleIframe.onload = sendBgMsg;
		sendBgMsg();
	}
}
export function resetPreviewBg() {
	[dom.previewGif, dom.previewContent, dom.bundleViewer].forEach(el => el.style.background = '');
	dom.bundleIframe.style.background = '';
	dom.previewBgBar.classList.add('hidden');
	dom.showRawJsBox.classList.add('hidden');
}

export function showPreviewBgBar() {
	dom.previewBgBar.classList.remove('hidden');
	const first = dom.previewBgBar.querySelector('.swatch-btn');
	if (first && !dom.previewBgBar.querySelector('.swatch-btn.active')) {
		first.classList.add('active');
	}
}

/* ── Palette swatch preview ────────────────────────── */
const GRADIENT_PRESETS = {
	realistic: [[12, 18, 30], [40, 80, 140], [120, 160, 120], [200, 170, 120], [220, 220, 210]],
	grayscale: [[0, 0, 0], [255, 255, 255]],
	sunset: [[255, 94, 58], [255, 149, 0], [255, 204, 0]],
	ocean: [[0, 24, 72], [0, 118, 255], [0, 217, 255]],
	neon: [[57, 255, 20], [0, 255, 255], [255, 0, 255]],
	forest: [[16, 64, 32], [34, 139, 34], [154, 205, 50]],
};

function interpolatePalette(stops, count) {
	const pal = [];
	const n = Math.max(2, count);
	const segs = stops.length - 1;
	for (let i = 0; i < n; i++) {
		const t = i / (n - 1);
		const seg = Math.min(segs - 1, Math.floor(t * segs));
		const lt = (t - seg / segs) * segs;
		const a = stops[seg], b = stops[seg + 1];
		pal.push([
			Math.round(a[0] + (b[0] - a[0]) * lt),
			Math.round(a[1] + (b[1] - a[1]) * lt),
			Math.round(a[2] + (b[2] - a[2]) * lt),
		]);
	}
	return pal;
}

export function updatePaletteSwatches() {
	dom.paletteSwatch.innerHTML = '';
	const name = dom.paletteSelect?.value || 'grayscale';
	const depth = parseInt(dom.depthSlider.value);
	const stops = GRADIENT_PRESETS[name];
	if (!stops) return;
	let colors;
	if (name === 'grayscale') {
		colors = [];
		for (let i = 0; i < depth; i++) {
			const v = Math.round((i / (depth - 1)) * 255);
			colors.push([v, v, v]);
		}
	} else {
		colors = interpolatePalette(stops, depth);
	}
	colors.forEach(([r, g, b]) => {
		const s = document.createElement('span');
		s.className = 'swatch';
		s.style.background = 'rgb(' + r + ',' + g + ',' + b + ')';
		s.title = 'rgb(' + r + ', ' + g + ', ' + b + ')';
		dom.paletteSwatch.appendChild(s);
	});
}
