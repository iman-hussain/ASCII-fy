import { dom } from './dom.js';
import { state, setState } from './state.js';
import { appendLog } from './utils.js';
import { probeFile } from '../app.js'; // circular bind to orchestrator for file load

export async function toggleCrop() {
	setState('isCropping', !state.isCropping);

	if (state.isCropping) {
		dom.cropBox.classList.remove('hidden');
		dom.previewVideo.pause();
		syncCropInputsToBox();
		dom.toggleCropBtn.textContent = '❌ Cancel Crop';
		dom.toggleCropBtn.style.background = 'var(--danger)';
		dom.toggleCropBtn.style.color = '#fff';
	} else {
		dom.cropBox.classList.add('hidden');
		dom.toggleCropBtn.textContent = '✂️ Toggle Crop Bounds';
		dom.toggleCropBtn.style.background = 'var(--surface)';
		dom.toggleCropBtn.style.color = '';
	}
}

export function getActiveCrop() {
	if (!state.isCropping) return null;
	const w = Math.round(parseFloat(dom.cropWInp.value));
	const h = Math.round(parseFloat(dom.cropHInp.value));
	const x = Math.round(parseFloat(dom.cropXInp.value));
	const y = Math.round(parseFloat(dom.cropYInp.value));
	if (isNaN(w) || isNaN(h) || w <= 0 || h <= 0) return null;
	return { w, h, x: x || 0, y: y || 0 };
}

export function syncCropInputsToBox() {
	if (!state.isCropping || !state.videoMeta || !state.videoMeta.width || !state.videoMeta.height) return;

	const intrinsicW = dom.previewVideo.videoWidth || state.videoMeta.width;
	const intrinsicH = dom.previewVideo.videoHeight || state.videoMeta.height;

	const rect = dom.previewVideo.getBoundingClientRect();
	const container = dom.previewVideoContainer.getBoundingClientRect();
	const vRatio = intrinsicW / intrinsicH;
	const cRatio = rect.width / rect.height;

	let renderW = rect.width;
	let renderH = rect.height;

	if (vRatio > cRatio) { renderH = rect.width / vRatio; }
	else { renderW = rect.height * vRatio; }

	const innerOffsetX = (rect.width - renderW) / 2;
	const innerOffsetY = (rect.height - renderH) / 2;
	const videoLeftInContainer = rect.left - container.left;
	const videoTopInContainer = rect.top - container.top;

	const scaleX = renderW / state.videoMeta.width;
	const scaleY = renderH / state.videoMeta.height;

	let w = parseFloat(dom.cropWInp.value) || state.videoMeta.width;
	let h = parseFloat(dom.cropHInp.value) || state.videoMeta.height;
	let x = parseFloat(dom.cropXInp.value) || 0;
	let y = parseFloat(dom.cropYInp.value) || 0;

	dom.cropBox.style.width = (w * scaleX) + 'px';
	dom.cropBox.style.height = (h * scaleY) + 'px';
	dom.cropBox.style.left = (videoLeftInContainer + innerOffsetX + x * scaleX) + 'px';
	dom.cropBox.style.top = (videoTopInContainer + innerOffsetY + y * scaleY) + 'px';
}

export function syncBoxToCropInputs() {
	if (!state.videoMeta || !state.videoMeta.width || !state.videoMeta.height) return;
	const intrinsicW = dom.previewVideo.videoWidth || state.videoMeta.width;
	const intrinsicH = dom.previewVideo.videoHeight || state.videoMeta.height;

	const rect = dom.previewVideo.getBoundingClientRect();
	const box = dom.cropBox.getBoundingClientRect();
	const container = dom.previewVideoContainer.getBoundingClientRect();

	const vRatio = intrinsicW / intrinsicH;
	const cRatio = rect.width / rect.height;
	let renderW = rect.width;
	let renderH = rect.height;
	if (vRatio > cRatio) { renderH = rect.width / vRatio; } else { renderW = rect.height * vRatio; }

	const innerOffsetX = (rect.width - renderW) / 2;
	const innerOffsetY = (rect.height - renderH) / 2;
	const videoLeftInContainer = rect.left - container.left;
	const videoTopInContainer = rect.top - container.top;

	const scaleX = renderW / state.videoMeta.width;
	const scaleY = renderH / state.videoMeta.height;

	let relLeft = box.left - container.left - videoLeftInContainer - innerOffsetX;
	let relTop = box.top - container.top - videoTopInContainer - innerOffsetY;

	let x = Math.round(relLeft / scaleX);
	let y = Math.round(relTop / scaleY);
	let w = Math.round(box.width / scaleX);
	let h = Math.round(box.height / scaleY);

	x = Math.max(0, Math.min(x, state.videoMeta.width - 2));
	y = Math.max(0, Math.min(y, state.videoMeta.height - 2));
	w = Math.max(2, Math.min(w, state.videoMeta.width - x));
	h = Math.max(2, Math.min(h, state.videoMeta.height - y));

	dom.cropXInp.value = x;
	dom.cropYInp.value = y;
	dom.cropWInp.value = w;
	dom.cropHInp.value = h;

	syncCropInputsToBox();
}

export function onCropDrag(e) {
	if (!state.dragContext) return;
	e.preventDefault();
	const dx = e.clientX - state.dragContext.startX;
	const dy = e.clientY - state.dragContext.startY;
	let { handle, startW, startH, startL, startT } = state.dragContext;

	if (handle === 'move') {
		dom.cropBox.style.left = (startL + dx) + 'px';
		dom.cropBox.style.top = (startT + dy) + 'px';
	} else {
		if (handle.includes('w')) {
			dom.cropBox.style.left = (startL + dx) + 'px';
			dom.cropBox.style.width = Math.max(10, startW - dx) + 'px';
		} else if (handle.includes('e')) {
			dom.cropBox.style.width = Math.max(10, startW + dx) + 'px';
		}
		if (handle.includes('n')) {
			dom.cropBox.style.top = (startT + dy) + 'px';
			dom.cropBox.style.height = Math.max(10, startH - dy) + 'px';
		} else if (handle.includes('s')) {
			dom.cropBox.style.height = Math.max(10, startH + dy) + 'px';
		}
	}
	syncBoxToCropInputs();
}

export function onCropDragEnd() {
	setState('dragContext', null);
	document.removeEventListener('pointermove', onCropDrag);
	document.removeEventListener('pointerup', onCropDragEnd);
	syncBoxToCropInputs();
}

export function syncTrimInputsToSliders() {
	let s = parseFloat(dom.trimStartInp.value) || 0;
	let e = parseFloat(dom.trimEndInp.value) || state.videoMeta?.duration || 100;
	if (s > e) { const t = s; s = e; e = t; }
	dom.trimStartSlider.value = s;
	dom.trimEndSlider.value = e;
	updateTrimRail();
}

export function syncTrimSlidersToInputs() {
	let s = parseFloat(dom.trimStartSlider.value);
	let e = parseFloat(dom.trimEndSlider.value);
	if (s > e) {
		const active = document.activeElement;
		if (active === dom.trimStartSlider) { dom.trimEndSlider.value = s; e = s; }
		else { dom.trimStartSlider.value = e; s = e; }
	}
	dom.trimStartInp.value = s;
	dom.trimEndInp.value = e;
	if (dom.trimStartVal) dom.trimStartVal.textContent = s.toFixed(1);
	if (dom.trimEndVal) dom.trimEndVal.textContent = e.toFixed(1);
	updateTrimRail();
}

export function updateTrimRail() {
	const max = parseFloat(dom.trimStartSlider.max) || 100;
	const s = parseFloat(dom.trimStartSlider.value);
	const e = parseFloat(dom.trimEndSlider.value);
	const leftPct = (s / max) * 100;
	const rightPct = 100 - (e / max) * 100;
	dom.trimFillRail.style.left = leftPct + '%';
	dom.trimFillRail.style.right = rightPct + '%';
}
