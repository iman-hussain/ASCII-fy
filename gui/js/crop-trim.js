import { dom } from './dom.js';
import { state, setState } from './state.js';
import { appendLog } from './utils.js';
import { probeFile } from '../app.js'; // circular bind to orchestrator for file load

/**
 * Determine if the loaded media is a still image (not a video/GIF).
 * Uses state.videoMeta rather than DOM visibility to be reliable.
 */
function isMediaImage() {
	return state.videoMeta && state.videoMeta.fps === 1 && state.videoMeta.duration === 0;
}

/**
 * Get the visible media element that the crop box should overlay.
 * Ensures the element is actually visible and has measurable dimensions.
 * For images, we must show the actual <img> (not the ASCII preview).
 * For videos/GIFs, we use the <video> element.
 */
function getVisibleMediaEl() {
	if (isMediaImage()) {
		return dom.previewImage;
	}
	return dom.previewVideo;
}

/**
 * Ensure the correct media element is visible for cropping.
 * For images, we swap back from ASCII preview to the actual image
 * so the crop overlay has something to position against.
 */
function ensureMediaVisibleForCrop() {
	if (isMediaImage()) {
		// Show the actual image, hide ASCII preview during crop
		dom.previewImage.classList.remove('hidden');
		dom.asciiPreview.classList.add('hidden');
		dom.previewVideo.classList.add('hidden');
		dom.previewVideoContainer.classList.remove('hidden');
	} else {
		// For video/GIF, ensure video is visible
		dom.previewVideo.classList.remove('hidden');
		dom.previewImage.classList.add('hidden');
		dom.previewVideoContainer.classList.remove('hidden');
	}
}

/**
 * Restore the media display when exiting crop mode.
 * For images, swap back to ASCII preview if it was previously shown.
 */
function restoreMediaAfterCrop() {
	if (isMediaImage()) {
		// If there's an ASCII preview available, show it and hide the image
		if (dom.asciiPreview.innerHTML && dom.asciiPreview.innerHTML.length > 0) {
			dom.asciiPreview.classList.remove('hidden');
			dom.previewImage.classList.add('hidden');
		}
	}
}

export async function toggleCrop() {
	setState('isCropping', !state.isCropping);

	if (state.isCropping) {
		// Ensure the real media element is visible so we can measure it
		ensureMediaVisibleForCrop();
		dom.cropBox.classList.remove('hidden');

		if (!isMediaImage()) {
			dom.previewVideo.pause();
		}

		// Wait for the media element to have dimensions
		const mediaEl = getVisibleMediaEl();
		await waitForMediaReady(mediaEl);

		// Wait one frame for the layout to settle before positioning
		await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
		syncCropInputsToBox();
		dom.toggleCropBtn.textContent = '❌ Cancel Crop';
		dom.toggleCropBtn.style.background = 'var(--danger)';
		dom.toggleCropBtn.style.color = '#fff';
	} else {
		dom.cropBox.classList.add('hidden');
		restoreMediaAfterCrop();
		dom.toggleCropBtn.textContent = '✂️ Toggle Crop Bounds';
		dom.toggleCropBtn.style.background = 'var(--surface)';
		dom.toggleCropBtn.style.color = '';
	}
}

/**
 * Wait until a media element (img or video) has valid intrinsic dimensions.
 * Returns immediately if already ready. Times out after 3 seconds.
 */
function waitForMediaReady(el) {
	return new Promise(resolve => {
		const check = () => {
			if (el.tagName === 'IMG') {
				return el.naturalWidth > 0 && el.naturalHeight > 0;
			}
			// Video element
			return el.videoWidth > 0 && el.videoHeight > 0;
		};

		if (check()) { resolve(); return; }

		const timeout = setTimeout(() => { cleanup(); resolve(); }, 3000);
		const event = el.tagName === 'IMG' ? 'load' : 'loadedmetadata';

		const onReady = () => {
			if (check()) { cleanup(); resolve(); }
		};
		const cleanup = () => {
			clearTimeout(timeout);
			el.removeEventListener(event, onReady);
			el.removeEventListener('loadeddata', onReady);
		};

		el.addEventListener(event, onReady);
		if (el.tagName === 'VIDEO') {
			el.addEventListener('loadeddata', onReady);
		}
	});
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

/**
 * Get the CSS zoom factor applied to the body.
 * getBoundingClientRect() returns viewport coords (post-zoom),
 * but CSS style.left/top/width/height are in the local CSS
 * coordinate space (pre-zoom). We must divide by zoom when
 * converting viewport measurements to CSS style values.
 */
function getZoom() {
	return parseFloat(getComputedStyle(document.body).zoom) || 1;
}

export function syncCropInputsToBox() {
	if (!state.isCropping || !state.videoMeta || !state.videoMeta.width || !state.videoMeta.height) return;

	const container = dom.previewVideoContainer.getBoundingClientRect();
	if (!container.width || !container.height) return;

	// Use state to determine media type, not DOM visibility
	const imgMode = isMediaImage();
	const mediaEl = getVisibleMediaEl();
	const mediaRect = mediaEl.getBoundingClientRect();
	if (!mediaRect.width || !mediaRect.height) return;

	// Compensate for CSS zoom: viewport coords → CSS coords
	const zoom = getZoom();

	const intrinsicW = (imgMode ? mediaEl.naturalWidth : mediaEl.videoWidth) || state.videoMeta.width;
	const intrinsicH = (imgMode ? mediaEl.naturalHeight : mediaEl.videoHeight) || state.videoMeta.height;
	const vRatio = intrinsicW / intrinsicH;

	// Compute the actual rendered content area within the media element
	// (object-fit: contain may leave letterbox/pillarbox gaps, and <video>
	// controls consume vertical space that shifts the content upward)
	let renderW, renderH;
	const elRatio = mediaRect.width / mediaRect.height;
	if (vRatio > elRatio) {
		// Video is wider than element → full width, letterboxed vertically
		renderW = mediaRect.width;
		renderH = mediaRect.width / vRatio;
	} else {
		// Video is taller than element → full height, pillarboxed horizontally
		renderH = mediaRect.height;
		renderW = mediaRect.height * vRatio;
	}

	// Content is centered within the media element's box
	const contentLeft = mediaRect.left + (mediaRect.width - renderW) / 2;
	const contentTop = mediaRect.top + (mediaRect.height - renderH) / 2;

	// Offset in viewport pixels, then convert to CSS pixels (÷ zoom)
	const offsetX = (contentLeft - container.left) / zoom;
	const offsetY = (contentTop - container.top) / zoom;

	// Scale: intrinsic pixels → CSS pixels (viewport scale ÷ zoom)
	const scaleX = renderW / state.videoMeta.width / zoom;
	const scaleY = renderH / state.videoMeta.height / zoom;

	let w = parseFloat(dom.cropWInp.value) || state.videoMeta.width;
	let h = parseFloat(dom.cropHInp.value) || state.videoMeta.height;
	let x = parseFloat(dom.cropXInp.value) || 0;
	let y = parseFloat(dom.cropYInp.value) || 0;

	dom.cropBox.style.width = (w * scaleX) + 'px';
	dom.cropBox.style.height = (h * scaleY) + 'px';
	dom.cropBox.style.left = (offsetX + x * scaleX) + 'px';
	dom.cropBox.style.top = (offsetY + y * scaleY) + 'px';
}

export function syncBoxToCropInputs() {
	if (!state.videoMeta || !state.videoMeta.width || !state.videoMeta.height) return;

	const container = dom.previewVideoContainer.getBoundingClientRect();
	if (!container.width || !container.height) return;

	// Use state to determine media type, not DOM visibility
	const imgMode = isMediaImage();
	const mediaEl = getVisibleMediaEl();
	const mediaRect = mediaEl.getBoundingClientRect();
	if (!mediaRect.width || !mediaRect.height) return;

	const intrinsicW = (imgMode ? mediaEl.naturalWidth : mediaEl.videoWidth) || state.videoMeta.width;
	const intrinsicH = (imgMode ? mediaEl.naturalHeight : mediaEl.videoHeight) || state.videoMeta.height;
	const vRatio = intrinsicW / intrinsicH;

	let renderW, renderH;
	const elRatio = mediaRect.width / mediaRect.height;
	if (vRatio > elRatio) {
		renderW = mediaRect.width;
		renderH = mediaRect.width / vRatio;
	} else {
		renderH = mediaRect.height;
		renderW = mediaRect.height * vRatio;
	}

	const contentLeft = mediaRect.left + (mediaRect.width - renderW) / 2;
	const contentTop = mediaRect.top + (mediaRect.height - renderH) / 2;
	const offsetX = contentLeft - container.left;
	const offsetY = contentTop - container.top;

	const scaleX = renderW / state.videoMeta.width;
	const scaleY = renderH / state.videoMeta.height;

	const box = dom.cropBox.getBoundingClientRect();
	let relLeft = box.left - container.left - offsetX;
	let relTop = box.top - container.top - offsetY;

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
	// e.clientX/Y are viewport coords; convert deltas to CSS coords
	const zoom = getZoom();
	const dx = (e.clientX - state.dragContext.startX) / zoom;
	const dy = (e.clientY - state.dragContext.startY) / zoom;
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
