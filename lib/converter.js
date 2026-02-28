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
import { CELL_W, CELL_H } from './gif.js';
import { AsciiEngine } from './engine.js';


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

	const engine = new AsciiEngine();

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
					const frame = engine.processFrame(pixels, scaledW, scaledH, outputWidth, evenHeight, sampleFactor, color, charMode, foreground, fgMask, detail);
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

let _mlSession = null;
let _mlSessionPromise = null;
let _ortModule = null;

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


