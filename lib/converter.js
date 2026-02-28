/**
 * ASCII-fi – Stream-based video-to-ASCII converter engine.
 *
 * Spawns FFmpeg as a child process, reads raw RGB24 frames from stdout,
 * and converts every pixel to an ASCII character via luminance mapping.
 * No intermediate files are ever written to disk.
 */

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { CHAR_RAMP, BLOCK_RAMP } from './render.js';
import { CELL_W, CELL_H } from './gif.js';


/**
 * Probe the input video to discover its dimensions and frame rate.
 * Returns { width, height, fps, duration }.
 */
export async function probeVideo(inputPath) {
	const ffprobePath = typeof ffprobeStatic === 'string'
		? ffprobeStatic
		: ffprobeStatic?.path || ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

	return new Promise((resolve, reject) => {
		const args = [
			'-v', 'error',
			'-select_streams', 'v:0',
			'-show_entries', 'stream=width,height,r_frame_rate,avg_frame_rate,sample_aspect_ratio,tags:stream_tags=rotate:format=duration',
			'-of', 'json',
			inputPath,
		];

		const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		let out = '';
		let err = '';

		proc.stdout.on('data', (chunk) => { out += chunk; });
		proc.stderr.on('data', (chunk) => { err += chunk; });

		proc.on('close', (code) => {
			if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
			try {
				const info = JSON.parse(out);
				const stream = info.streams[0];

				// Handle metadata rotation (e.g. mobile phones recording vertical video)
				let width = stream.width;
				let height = stream.height;
				if (stream.tags && stream.tags.rotate) {
					const angle = Math.abs(parseInt(stream.tags.rotate));
					if (angle === 90 || angle === 270) {
						width = stream.height;
						height = stream.width;
					}
				}

				const [num, den] = stream.r_frame_rate.split('/').map(Number);
				let fps = den ? num / den : num;
				// WebM from MediaRecorder uses 1ms timebase → r_frame_rate = 1000/1
				if (fps > 120) {
					const avgRate = stream.avg_frame_rate;
					if (avgRate && avgRate !== '0/0') {
						const [an, ad] = avgRate.split('/').map(Number);
						const avgFps = ad ? an / ad : an;
						fps = (avgFps > 0 && avgFps <= 120) ? avgFps : 30;
					} else { fps = 30; }
				}
				let sar = 1;
				if (stream.sample_aspect_ratio && stream.sample_aspect_ratio !== '0:1') {
					const [sarNum, sarDen] = stream.sample_aspect_ratio.split(':').map(Number);
					if (sarNum && sarDen) sar = sarNum / sarDen;
				}
				resolve({
					width,
					height,
					fps: fps,
					duration: info.format ? Number(info.format.duration) : undefined,
					sar: sar,
				});
			} catch (e) {
				reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
			}
		});

		proc.on('error', reject);
	});
}

/**
 * Convert a video file to an array of ASCII frames (streaming).
 *
 * @param {object}   opts
 * @param {string}   opts.inputPath   – Path to input video file.
 * @param {number}   opts.outputWidth – Target ASCII width (characters).
 * @param {boolean}  opts.color       – If true, store per-char RGB values.
 * @param {function} [opts.onFrame]   – Callback invoked with (frameIndex, asciiFrame).
 * @param {object}   [opts.foreground] – Foreground isolation options (mode/background/threshold/modelPath).
 * @returns {Promise<{ frames: any[], width: number, height: number, fps: number }>}
 */
export async function convert({ inputPath, outputWidth = 100, outputHeight, color = false, onFrame, startTime, endTime, meta, collectFrames = true, targetFps, tone, charMode = 'ascii', foreground = null, crop = null, signal = null, detail = 100 }) {
	// 1. Probe video for metadata
	const info = (meta && meta.width && meta.height)
		? meta
		: await probeVideo(inputPath);

	resetFrameState();

	// Compute ASCII grid height that preserves the source video's visual aspect ratio.
	// Each character cell renders as CELL_W × CELL_H pixels in the GIF, or
	// ≈0.6em × 0.8em in the browser player (which gives the same 0.75 ratio).
	// To match the source aspect: rows = cols × (srcH / srcW) × (CELL_W / CELL_H)
	const srcH = crop && crop.h ? crop.h : info.height;
	const srcW = (crop && crop.w ? crop.w : info.width) * (info.sar || 1);
	const targetHeight = outputHeight || Math.round(outputWidth * (srcH / srcW) * (CELL_W / CELL_H));
	const asciiHeight = Math.max(1, targetHeight);
	// Ensure even (FFmpeg -2 requirement)
	const evenHeight = asciiHeight % 2 === 0 ? asciiHeight : asciiHeight + 1;
	// ASCII mode uses 4× oversampling for 2×2 quadrant edge detection;
	// block mode only needs average colour so 2× is sufficient.
	const sampleFactor = charMode === 'block' ? 2 : 4;
	const scaledW = outputWidth * sampleFactor;
	const scaledH = evenHeight * sampleFactor;

	// 2. Spawn FFmpeg – stream raw RGB24 pixels to stdout
	const filters = [];

	if (crop && crop.w && crop.h) {
		filters.push(`crop=${crop.w}:${crop.h}:${crop.x || 0}:${crop.y || 0}`);
	}

	filters.push(`scale=${scaledW}:${scaledH}:flags=lanczos`);

	if (targetFps) filters.push(`fps=${targetFps}`);
	if (tone) {
		const contrast = typeof tone.contrast === 'number' ? tone.contrast : 1.0;
		const brightness = typeof tone.brightness === 'number' ? tone.brightness : 0.0;
		const saturation = typeof tone.saturation === 'number' ? tone.saturation : 1.0;
		const gamma = typeof tone.gamma === 'number' ? tone.gamma : 1.0;
		filters.push(`eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}:gamma=${gamma}`);
	}

	const ffmpegArgs = [
		...(typeof startTime === 'number' ? ['-ss', String(startTime)] : []),
		'-i', inputPath,
		...(typeof endTime === 'number' ? ['-t', String(Math.max(0, endTime - (startTime || 0)))] : []),
		'-f', 'image2pipe',
		'-vcodec', 'rawvideo',
		'-pix_fmt', 'rgb24',
		'-vf', filters.join(','),
		'-',
	];

	const proc = spawn(ffmpegPath, ffmpegArgs, {
		stdio: ['ignore', 'pipe', 'pipe'],
	});

	const frameByteLength = scaledW * scaledH * 3; // 3 bytes per pixel (RGB)
	const frames = collectFrames ? [] : null;
	let buffer = Buffer.alloc(0);
	let frameIndex = 0;
	const fg = foreground && (foreground.mode === 'motion' || foreground.mode === 'ml') ? foreground : null;
	let processing = Promise.resolve();
	let aborted = false;

	// Listen for abort signal
	if (signal) {
		if (signal.aborted) { proc.kill('SIGKILL'); return Promise.reject(new Error('Aborted')); }
		signal.addEventListener('abort', () => {
			aborted = true;
			try { proc.kill('SIGKILL'); } catch { }
		}, { once: true });
	}

	return new Promise((resolve, reject) => {
		proc.stdout.on('data', (chunk) => {
			// Accumulate data – handles partial & multi-frame chunks
			buffer = Buffer.concat([buffer, chunk]);

			// Process every complete frame sitting in the buffer
			while (buffer.length >= frameByteLength) {
				if (aborted) break;
				const frameBuf = buffer.subarray(0, frameByteLength);
				const pixels = Uint8Array.from(frameBuf);
				const idx = frameIndex;
				frameIndex++;

				processing = processing.then(async () => {
					if (aborted) return;
					const fgMask = (fg && fg.mode === 'ml')
						? await buildMlMask(pixels, scaledW, scaledH, outputWidth, evenHeight, fg)
						: null;
					const frame = processFrame(pixels, scaledW, scaledH, outputWidth, evenHeight, sampleFactor, color, charMode, foreground, fgMask, detail);
					if (frames) frames.push(frame);
					if (onFrame) await onFrame(idx, frame);
				}).catch(reject);

				// Advance past the consumed frame
				buffer = buffer.subarray(frameByteLength);
			}
		});

		let stderrOutput = '';
		proc.stderr.on('data', (chunk) => { stderrOutput += chunk; });

		proc.on('close', (code) => {
			if (aborted) {
				return reject(new Error('Conversion aborted by user.'));
			}
			if (code !== 0 && frames && frames.length === 0) {
				return reject(new Error(`FFmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`));
			}
			const duration = typeof endTime === 'number'
				? Math.max(0, endTime - (startTime || 0))
				: info.duration;

			processing.then(() => {
				resolve({
					frames: frames || [],
					width: outputWidth,
					height: evenHeight,
					fps: targetFps || info.fps,
					duration,
				});
			}).catch(reject);
		});

		proc.on('error', reject);
	});
}

// Previous-frame state for character stabilisation
let _prevFrameColors = null;
let _prevFrameChars = null;
let _bgModelColors = null;      // motion mask: running average of background RGB per cell
let _frozenChars = null;        // freeze mode: first-frame chars snapshot
let _frozenColors = null;       // freeze mode: first-frame colors snapshot
let _frameCounter = 0;
let _mlSession = null;
let _mlSessionPromise = null;
let _ortModule = null;

// Squared RGB distance threshold below which a cell's colour is "the same".
const COLOR_STABLE_THRESHOLD = 18 * 18 * 3; // ~18 per channel

// ─── Edge-detection ASCII character selection ────────────────────────────────
// For each cell we compute 2×2 quadrant luminances (TL/TR/BL/BR).
// If the quadrants are similar (low range) → density char from CHAR_RAMP.
// Otherwise classify the bright-quadrant pattern → edge/shape character.

const EDGE_THRESHOLD = 30; // min quadrant lum range to count as an edge

// 4-bit lookup: bit3=TL bit2=TR bit1=BL bit0=BR  (1 = brighter than avg)
const EDGE_TABLE = [
	' ',    // 0000  (handled separately)
	'.',    // 0001  BR bright
	'.',    // 0010  BL bright
	'_',    // 0011  bottom bright
	'.',    // 0100  TR bright
	'|',    // 0101  right column
	'/',    // 0110  anti-diagonal
	'J',    // 0111  TL dark corner
	'.',    // 1000  TL bright
	'\\',   // 1001  main diagonal
	'|',    // 1010  left column
	'L',    // 1011  TR dark corner
	'-',    // 1100  top bright
	'7',    // 1101  BL dark corner
	'r',    // 1110  BR dark corner
	'#',    // 1111  all bright  (handled separately)
];

function resetFrameState() {
	_prevFrameColors = null;
	_prevFrameChars = null;
	_bgModelColors = null;
	_frozenChars = null;
	_frozenColors = null;
	_frameCounter = 0;
}

function parseHexColor(hex, fallback) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
	if (!m) return fallback;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

async function getMlSession(modelPath) {
	if (_mlSession) return _mlSession;
	if (_mlSessionPromise) return _mlSessionPromise;
	_mlSessionPromise = (async () => {
		_ortModule = _ortModule || await import('onnxruntime-node');
		const session = await _ortModule.InferenceSession.create(modelPath);
		_mlSession = session;
		return session;
	})();
	return _mlSessionPromise;
}

function resizeRgbNearest(pixels, srcW, srcH, dstW, dstH) {
	const out = new Uint8Array(dstW * dstH * 3);
	for (let y = 0; y < dstH; y++) {
		const sy = Math.min(srcH - 1, Math.round((y / dstH) * srcH));
		for (let x = 0; x < dstW; x++) {
			const sx = Math.min(srcW - 1, Math.round((x / dstW) * srcW));
			const si = (sy * srcW + sx) * 3;
			const di = (y * dstW + x) * 3;
			out[di] = pixels[si];
			out[di + 1] = pixels[si + 1];
			out[di + 2] = pixels[si + 2];
		}
	}
	return out;
}

async function buildMlMask(pixels, srcW, srcH, outW, outH, fg) {
	const modelSize = fg.modelSize || 256;
	const resized = resizeRgbNearest(pixels, srcW, srcH, modelSize, modelSize);

	const session = await getMlSession(fg.modelPath);
	_ortModule = _ortModule || await import('onnxruntime-node');
	const inputName = session.inputNames[0];
	const outputName = session.outputNames[0];

	// Auto-detect input layout from model metadata
	const inputMeta = session.inputNames.length && session.inputMetadata
		? session.inputMetadata[inputName]
		: null;
	const inputDims = inputMeta?.dimensions || inputMeta?.dims || null;
	// Heuristic: if 4th dim is 3 → NHWC [1,H,W,3]; if 2nd dim is 3 → NCHW [1,3,H,W]
	const isNHWCInput = inputDims
		? (inputDims[3] === 3 || inputDims[3] === '3')
		: false;

	const plane = modelSize * modelSize;
	const input = new Float32Array(1 * 3 * plane);

	if (isNHWCInput) {
		// NHWC: [1, H, W, 3]
		for (let i = 0; i < plane; i++) {
			input[i * 3] = resized[i * 3] / 255;
			input[i * 3 + 1] = resized[i * 3 + 1] / 255;
			input[i * 3 + 2] = resized[i * 3 + 2] / 255;
		}
	} else {
		// NCHW: [1, 3, H, W]
		for (let i = 0; i < plane; i++) {
			input[i] = resized[i * 3] / 255;
			input[plane + i] = resized[i * 3 + 1] / 255;
			input[plane * 2 + i] = resized[i * 3 + 2] / 255;
		}
	}

	const feeds = {};
	const inputShape = isNHWCInput
		? [1, modelSize, modelSize, 3]
		: [1, 3, modelSize, modelSize];
	feeds[inputName] = new _ortModule.Tensor('float32', input, inputShape);

	let results;
	try {
		results = await session.run(feeds);
	} catch {
		// If the initial shape guess failed, try the other layout
		const altInput = new Float32Array(1 * 3 * plane);
		if (isNHWCInput) {
			for (let i = 0; i < plane; i++) {
				altInput[i] = resized[i * 3] / 255;
				altInput[plane + i] = resized[i * 3 + 1] / 255;
				altInput[plane * 2 + i] = resized[i * 3 + 2] / 255;
			}
		} else {
			for (let i = 0; i < plane; i++) {
				altInput[i * 3] = resized[i * 3] / 255;
				altInput[i * 3 + 1] = resized[i * 3 + 1] / 255;
				altInput[i * 3 + 2] = resized[i * 3 + 2] / 255;
			}
		}
		const altShape = isNHWCInput
			? [1, 3, modelSize, modelSize]
			: [1, modelSize, modelSize, 3];
		feeds[inputName] = new _ortModule.Tensor('float32', altInput, altShape);
		results = await session.run(feeds);
	}
	const output = results[outputName];
	const data = output.data;
	const shape = output.dims;

	const threshold = typeof fg.threshold === 'number' ? fg.threshold / 100 : 0.5;
	const mask = new Array(outW * outH).fill(false);

	// Determine output layout: could be [1,1,H,W], [1,2,H,W], [1,H,W,1], [1,H,W,2], etc.
	const numClasses = (shape.length === 4)
		? Math.min(shape[1], shape[3])  // whichever dim is smallest is likely classes
		: 1;
	const isNCHW = shape.length === 4 && shape[2] === modelSize && shape[3] === modelSize;
	const isNHWC = shape.length === 4 && shape[1] === modelSize && shape[2] === modelSize;
	const nchClasses = isNCHW ? shape[1] : (isNHWC ? shape[3] : 1);

	for (let y = 0; y < outH; y++) {
		const sy = Math.min(modelSize - 1, Math.round((y / outH) * modelSize));
		for (let x = 0; x < outW; x++) {
			const sx = Math.min(modelSize - 1, Math.round((x / outW) * modelSize));
			let v;
			const spatialIdx = sy * modelSize + sx;

			if (isNCHW && nchClasses >= 2) {
				// [1, C, H, W] with 2+ classes – foreground is channel 1
				v = data[plane + spatialIdx];
			} else if (isNHWC && nchClasses >= 2) {
				// [1, H, W, C] with 2+ classes – foreground is index 1
				v = data[spatialIdx * nchClasses + 1];
			} else {
				// Single channel – use directly
				v = data[spatialIdx];
			}

			// Apply sigmoid if raw logits (outside [0, 1] range)
			if (v < -0.5 || v > 1.5) v = 1 / (1 + Math.exp(-v));
			// Clamp to [0, 1]
			v = Math.max(0, Math.min(1, v));

			mask[y * outW + x] = v >= threshold;
		}
	}

	// ── Morphological cleanup: erode then dilate to remove isolated pixels ──
	// Erode: a cell stays true only if at least `erodeMin` of its 3×3 neighbours are true
	const erodeMin = 3;
	const eroded = new Array(outW * outH).fill(false);
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			if (!mask[y * outW + x]) continue;
			let count = 0;
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const ny = y + dy, nx = x + dx;
					if (ny >= 0 && ny < outH && nx >= 0 && nx < outW && mask[ny * outW + nx]) count++;
				}
			}
			eroded[y * outW + x] = count >= erodeMin;
		}
	}

	// Dilate: expand the eroded mask back by 1 pixel to restore edges
	const cleaned = new Array(outW * outH).fill(false);
	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			if (eroded[y * outW + x]) { cleaned[y * outW + x] = true; continue; }
			// Check if any neighbour in the eroded mask is true
			outer:
			for (let dy = -1; dy <= 1; dy++) {
				for (let dx = -1; dx <= 1; dx++) {
					const ny = y + dy, nx = x + dx;
					if (ny >= 0 && ny < outH && nx >= 0 && nx < outW && eroded[ny * outW + nx]) {
						// Only re-include if the original mask also had this pixel
						if (mask[y * outW + x]) cleaned[y * outW + x] = true;
						break outer;
					}
				}
			}
		}
	}

	return cleaned;
}

function selectEdgeChar(tl, tr, bl, br, detail = 100) {
	const avg = (tl + tr + bl + br) / 4;
	if (avg < 8) return ' ';

	const range = Math.max(tl, tr, bl, br) - Math.min(tl, tr, bl, br);

	// detail 0-100 controls fill visibility:
	//   100 = full fill (show everything)
	//     0 = outline only (suppress all fills)
	// Intermediate values set a luminance floor below which fills are suppressed.
	const fillThreshold = detail < 100 ? 255 * (1 - detail / 100) : 0;

	// Uniform → density character
	if (range < EDGE_THRESHOLD) {
		if (avg < fillThreshold) return ' ';
		const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
		return CHAR_RAMP[idx];
	}

	// Classify each quadrant relative to the average
	const pattern = ((tl > avg ? 1 : 0) << 3) |
		((tr > avg ? 1 : 0) << 2) |
		((bl > avg ? 1 : 0) << 1) |
		(br > avg ? 1 : 0);

	// Degenerate cases (all same side of avg) → density
	if (pattern === 0 || pattern === 15) {
		if (avg < fillThreshold) return ' ';
		const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
		return CHAR_RAMP[idx];
	}

	return EDGE_TABLE[pattern];
}

// ─── Frame processor ─────────────────────────────────────────────────────────

/**
 * Process a single raw RGB24 frame into ASCII data.
 *
 * Foreground isolation modes:
 *   - "transparent" / "solid": background cells become ' ' with bgRgb colour.
 *   - "keep" (freeze): frame 1 is stored in full; subsequent frames show
 *     the frozen background for bg cells and live data for fg cells.
 *
 * Background detection:
 *   - "motion": compare each cell to a running average; large diff = foreground.
 *   - "ml": per-frame segmentation mask from an ONNX model.
 */
function processFrame(pixels, scaledW, scaledH, outW, outH, sampleFactor, color, charMode, foreground, fgMask, detail = 100) {
	const totalChars = outW * outH;
	const charsArr = new Array(totalChars);
	let colors;

	_frameCounter++;

	const useForeground = foreground && (foreground.mode === 'motion' || foreground.mode === 'ml');
	const bgMode = foreground?.background || 'solid';   // 'transparent' | 'solid' | 'keep'
	const motionThreshold = typeof foreground?.threshold === 'number' ? foreground.threshold : 20;
	const motionThresholdSq = motionThreshold * motionThreshold * 3;
	const bgRgb = (bgMode === 'solid')
		? parseHexColor(foreground?.bg, [0, 0, 0])
		: [0, 0, 0];

	if (color) {
		colors = new Array(totalChars);
	}

	const blockW = sampleFactor;
	const blockH = sampleFactor;
	const denom = blockW * blockH;
	const halfW = blockW >> 1;
	const halfH = blockH >> 1;
	const qDenom = halfW * halfH;
	const useBlocks = charMode === 'block';

	// ── First pass: compute char + colour for every cell (ignoring fg/bg) ──
	const rawChars = new Array(totalChars);
	const rawColors = color ? new Array(totalChars) : null;

	for (let y = 0; y < outH; y++) {
		for (let x = 0; x < outW; x++) {
			let rSum = 0, gSum = 0, bSum = 0;
			let qTL = 0, qTR = 0, qBL = 0, qBR = 0;
			const startX = x * blockW;
			const startY = y * blockH;

			for (let by = 0; by < blockH; by++) {
				const row = (startY + by) * scaledW;
				for (let bx = 0; bx < blockW; bx++) {
					const idx = (row + startX + bx) * 3;
					const pr = pixels[idx];
					const pg = pixels[idx + 1];
					const pb = pixels[idx + 2];
					rSum += pr; gSum += pg; bSum += pb;
					if (!useBlocks) {
						const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
						if (by < halfH) {
							if (bx < halfW) qTL += lum; else qTR += lum;
						} else {
							if (bx < halfW) qBL += lum; else qBR += lum;
						}
					}
				}
			}

			const r = rSum / denom, g = gSum / denom, b = bSum / denom;
			const i = y * outW + x;
			const rR = Math.round(r), gR = Math.round(g), bR = Math.round(b);

			let ch;
			if (useBlocks) {
				const yLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
				const fillThreshold = detail < 100 ? 255 * (1 - detail / 100) : 0;
				if (yLum < fillThreshold) {
					ch = ' ';
				} else {
					const ci = Math.min(BLOCK_RAMP.length - 1, Math.floor((yLum / 255) * BLOCK_RAMP.length));
					ch = BLOCK_RAMP[ci];
				}
			} else {
				ch = selectEdgeChar(qTL / qDenom, qTR / qDenom, qBL / qDenom, qBR / qDenom, detail);
			}

			rawChars[i] = ch;
			if (rawColors) rawColors[i] = [rR, gR, bR];
		}
	}

	// ── Freeze mode: snapshot frame 1 as the frozen background ──────────
	if (useForeground && bgMode === 'keep' && _frameCounter === 1) {
		_frozenChars = rawChars.slice();
		_frozenColors = rawColors ? rawColors.slice() : null;
	}

	// ── Build foreground mask ──────────────────────────────────────────
	const fgFlags = useForeground ? new Uint8Array(totalChars) : null;

	if (useForeground) {
		if (foreground.mode === 'motion') {
			// Initialise background model on first frame
			if (!_bgModelColors) {
				_bgModelColors = new Array(totalChars);
				for (let i = 0; i < totalChars; i++) {
					_bgModelColors[i] = rawColors
						? [rawColors[i][0], rawColors[i][1], rawColors[i][2]]
						: [128, 128, 128];
				}
				// Frame 1: treat everything as foreground so it's not blank.
				// The background model is still initialized from this frame, so
				// frame 2 onward will correctly detect motion against it.
				for (let i = 0; i < totalChars; i++) fgFlags[i] = 1;
			} else {
				for (let i = 0; i < totalChars; i++) {
					const cr = rawColors ? rawColors[i][0] : 128;
					const cg = rawColors ? rawColors[i][1] : 128;
					const cb = rawColors ? rawColors[i][2] : 128;
					const bgc = _bgModelColors[i];
					const dr = cr - bgc[0], dg = cg - bgc[1], db = cb - bgc[2];
					const dist = dr * dr + dg * dg + db * db;

					if (dist >= motionThresholdSq) {
						fgFlags[i] = 1; // foreground (moving)
					} else {
						fgFlags[i] = 0; // background (static)
						// Slowly adapt background model
						const a = 0.05;
						bgc[0] = Math.round(bgc[0] * (1 - a) + cr * a);
						bgc[1] = Math.round(bgc[1] * (1 - a) + cg * a);
						bgc[2] = Math.round(bgc[2] * (1 - a) + cb * a);
					}
				}
			}
		} else if (foreground.mode === 'ml' && fgMask) {
			for (let i = 0; i < totalChars; i++) {
				fgFlags[i] = fgMask[i] ? 1 : 0;
			}
		}
	}

	// ── Second pass: assemble output with foreground/background logic ──
	for (let i = 0; i < totalChars; i++) {
		const isFg = !useForeground || (fgFlags && fgFlags[i]);

		if (useForeground && !isFg) {
			// --- This cell is BACKGROUND ---
			if (bgMode === 'keep') {
				// Freeze mode: show frame-1 snapshot
				charsArr[i] = (_frozenChars && _frozenChars[i]) || ' ';
				if (color) colors[i] = (_frozenColors && _frozenColors[i]) || bgRgb;
			} else {
				// Transparent or solid: blank cell
				charsArr[i] = ' ';
				if (color) colors[i] = bgRgb;
			}
			continue;
		}

		// --- This cell is FOREGROUND (or fg isolation is off) ---
		const ch = rawChars[i];

		// If the cell character is an empty space (density gap), force its colour to be the background color
		// so that rendering engines don't paint the space with the source video's original pixel color.
		if (color) {
			colors[i] = (ch === ' ') ? bgRgb : rawColors[i];
		}

		// Colour stabilisation — reuse prev char when colour barely changed.
		// IMPORTANT: Skip stabilisation when the previous frame had this cell
		// as background (space char with bgRgb), otherwise the space bleeds
		// into the current foreground cell.
		if (_prevFrameColors && _prevFrameChars && _prevFrameColors[i]
			&& _prevFrameChars[i] !== ' ') {
			const pc = _prevFrameColors[i];
			const cr = rawColors ? rawColors[i][0] : 0;
			const cg = rawColors ? rawColors[i][1] : 0;
			const cb = rawColors ? rawColors[i][2] : 0;
			const dr2 = cr - pc[0], dg2 = cg - pc[1], db2 = cb - pc[2];
			if (dr2 * dr2 + dg2 * dg2 + db2 * db2 < COLOR_STABLE_THRESHOLD) {
				charsArr[i] = _prevFrameChars[i];
				continue;
			}
		}

		charsArr[i] = ch;
	}

	const chars = charsArr.join('');

	// Store RAW colours for stabilisation comparison (not bg-modified output),
	// so cells transitioning from bg→fg compare against actual video data.
	_prevFrameColors = rawColors ? rawColors.slice() : null;
	_prevFrameChars = charsArr.slice();

	return color ? { chars, colors } : { chars };
}
