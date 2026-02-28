/**
 * ASCII-fi – WebAssembly Browser Adapter
 *
 * Orchestrates @ffmpeg/ffmpeg to run natively in the browser.
 * Extracts RGB24 frames to the virtual FS and streams them
 * to the shared AsciiEngine.
 */

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile } from '@ffmpeg/util';
import { AsciiEngine } from './engine.js';
import { CELL_W, CELL_H } from './gif.js';

let ffmpeg = null;

async function initFFmpeg() {
	if (ffmpeg) return ffmpeg;
	ffmpeg = new FFmpeg();

	// Check for SharedArrayBuffer support (required by modern ffmpeg.wasm)
	if (typeof SharedArrayBuffer === 'undefined') {
		console.error("[ASCII-fy] SharedArrayBuffer is not available. ffmpeg.wasm requires COOP/COEP headers.");
		throw new Error("SharedArrayBuffer is not available. The page needs Cross-Origin-Opener-Policy and Cross-Origin-Embedder-Policy headers. Please refresh the page.");
	}

	const ffmpegCoreVersion = '0.12.6';
	const primaryCoreUrl = `https://unpkg.com/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.js`;
	const primaryWasmUrl = `https://unpkg.com/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.wasm`;
	const mirrorCoreUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.js`;
	const mirrorWasmUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.wasm`;

	console.log('[ASCII-fy] Loading FFmpeg from CDN...');

	try {
		await ffmpeg.load({
			coreURL: primaryCoreUrl,
			wasmURL: primaryWasmUrl,
		});
		console.log('[ASCII-fy] FFmpeg loaded successfully from primary CDN');
	} catch (primaryError) {
		console.warn('[ASCII-fy] Primary FFmpeg CDN failed, trying mirror...', primaryError);
		try {
			await ffmpeg.load({
				coreURL: mirrorCoreUrl,
				wasmURL: mirrorWasmUrl,
			});
			console.log('[ASCII-fy] FFmpeg loaded successfully from mirror CDN');
		} catch (mirrorError) {
			console.error('[ASCII-fy] Both FFmpeg CDNs failed:', mirrorError);
			throw new Error('Failed to load FFmpeg. Please check your internet connection and try again.');
		}
	}
	return ffmpeg;
}

/**
 * Probe video dimensions and framerate using ffmpeg.wasm.
 * Since FFprobe isn't fully exposed in the same way, we run a fast
 * dummy conversion and parse the stderr output.
 */
export async function probeVideoWeb(file) {
	const ff = await initFFmpeg();
	const inputName = 'probe_input.' + file.name.split('.').pop();
	await ff.writeFile(inputName, await fetchFile(file));

	let width = 640, height = 480, fps = 30, duration = 0;

	return new Promise(async (resolve) => {
		const logHandler = ({ message }) => {
			// Typical FFmpeg output: "Stream #0:0(und): Video: h264, yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps"
			const videoMatch = message.match(/Video: .*?, .*?, (\d+)x(\d+).*?([\d.]+) fps/);
			if (videoMatch) {
				width = parseInt(videoMatch[1], 10);
				height = parseInt(videoMatch[2], 10);
				fps = parseFloat(videoMatch[3]);
			}
			// "Duration: 00:00:05.12, start: 0.000000, bitrate: 1234 kb/s"
			const durMatch = message.match(/Duration: (\d+):(\d+):([\d.]+)/);
			if (durMatch) {
				const [h, m, s] = durMatch.slice(1).map(Number);
				duration = (h * 3600) + (m * 60) + s;
			}
		};

		ff.on('log', logHandler);

		try {
			// Run a fast, empty command just to get logs
			await ff.exec(['-i', inputName, '-f', 'null', '-']);
		} catch (e) {
			console.warn("Probe warning:", e);
		} finally {
			ff.off('log', logHandler);
			try { await ff.deleteFile(inputName); } catch (e) { }
			resolve({ width, height, fps, duration, sar: 1 }); // SAR mapping omitted for simplicity
		}
	});
}

/**
 * Convert a video file to ASCII frames entirely in the browser.
 */
export async function convertWeb({ file, outputWidth = 100, outputHeight, color = false, onFrame, startTime, endTime, meta, collectFrames = true, targetFps, tone, charMode = 'ascii', foreground = null, crop = null, signal = null, detail = 100 }) {
	const ff = await initFFmpeg();
	const inputName = 'input.' + file.name.split('.').pop();
	await ff.writeFile(inputName, await fetchFile(file));

	const info = (meta && meta.width && meta.height) ? meta : await probeVideoWeb(file);

	const engine = new AsciiEngine();

	const srcH = crop && crop.h ? crop.h : info.height;
	const srcW = (crop && crop.w ? crop.w : info.width) * (info.sar || 1);
	const targetHeight = outputHeight || Math.round(outputWidth * (srcH / srcW) * (CELL_W / CELL_H));
	const asciiHeight = Math.max(1, targetHeight);
	const evenHeight = asciiHeight % 2 === 0 ? asciiHeight : asciiHeight + 1;
	const sampleFactor = charMode === 'block' ? 2 : 4;
	const scaledW = outputWidth * sampleFactor;
	const scaledH = evenHeight * sampleFactor;

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

	const outPattern = 'frame_%05d.raw';

	const ffmpegArgs = [
		...(typeof startTime === 'number' ? ['-ss', String(startTime)] : []),
		'-i', inputName,
		...(typeof endTime === 'number' ? ['-t', String(Math.max(0, endTime - (startTime || 0)))] : []),
		'-f', 'image2',
		'-vcodec', 'rawvideo',
		'-pix_fmt', 'rgb24',
		'-vf', filters.join(','),
		outPattern
	];

	if (signal) {
		if (signal.aborted) throw new Error('Aborted');
		signal.addEventListener('abort', () => {
			ff.terminate(); // Kill the WASM worker
		}, { once: true });
	}

	// 1. Run the extraction (WASM Native)
	// Instead of piping (which ffmpeg.wasm struggles with for massive streams),
	// we extract frames to the virtual FS and read them sequentially.
	await ff.exec(ffmpegArgs);

	// 2. Read and process frames sequentially
	const frames = collectFrames ? [] : null;
	let frameIndex = 0;
	let aborted = false;

	if (signal) {
		signal.addEventListener('abort', () => { aborted = true; }, { once: true });
	}

	// Calculate how many frames were outputted
	const dirContents = await ff.listDir('.');
	const frameFiles = dirContents.filter(f => f.name.startsWith('frame_') && f.name.endsWith('.raw')).sort((a, b) => a.name.localeCompare(b.name));

	// ML background isolation not yet supported in zero-dependency WASM
	const fg = foreground && foreground.mode === 'motion' ? foreground : null;

	for (const fileChunk of frameFiles) {
		if (aborted) break;

		const frameData = await ff.readFile(fileChunk.name);
		const pixels = new Uint8Array(frameData);

		const frame = engine.processFrame(pixels, scaledW, scaledH, outputWidth, evenHeight, sampleFactor, color, charMode, fg, null, detail);

		if (frames) frames.push(frame);
		if (onFrame) await onFrame(frameIndex, frame);

		frameIndex++;

		// Clean up virtual FS memory as we go
		await ff.deleteFile(fileChunk.name);
	}

	try { await ff.deleteFile(inputName); } catch (e) { }

	const outputDuration = typeof endTime === 'number'
		? Math.max(0, endTime - (startTime || 0))
		: info.duration;

	return {
		frames: frames || [],
		width: outputWidth,
		height: evenHeight,
		fps: targetFps || info.fps,
		duration: outputDuration,
	};
}
