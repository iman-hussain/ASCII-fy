/**
 * ASCII-fi – WebAssembly Browser Adapter
 *
 * Orchestrates @ffmpeg/ffmpeg to run natively in the browser.
 * Extracts RGB24 frames to the virtual FS and streams them
 * to the shared AsciiEngine.
 */

// Use dynamic imports to allow import map resolution in workers
let FFmpeg = null;
let fetchFile = null;
let AsciiEngine = null;
let CELL_W = null;
let CELL_H = null;

async function loadDependencies() {
	if (FFmpeg) return; // Already loaded

	try {
		// Use absolute URLs instead of bare specifiers so workers can resolve them
		const ffmpegModule = await import('https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js');
		FFmpeg = ffmpegModule.FFmpeg;

		const utilModule = await import('https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js');
		fetchFile = utilModule.fetchFile;

		const engineModule = await import('./engine.js');
		AsciiEngine = engineModule.AsciiEngine;

		const gifModule = await import('./gif.js');
		CELL_W = gifModule.CELL_W;
		CELL_H = gifModule.CELL_H;
	} catch (err) {
		console.error('[ASCII-fy] Failed to load dependencies:', err);
		throw new Error('Failed to load required modules: ' + err.message);
	}
}

let ffmpeg = null;

// Helper function to add timeout to a promise
function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000} seconds`)), timeoutMs)
		)
	]);
}

async function initFFmpeg() {
	await loadDependencies();

	if (ffmpeg) return ffmpeg;
	ffmpeg = new FFmpeg();

	// Check for SharedArrayBuffer support (required by modern ffmpeg.wasm)
	if (typeof SharedArrayBuffer === 'undefined') {
		console.error("[ASCII-fy] SharedArrayBuffer is not available. ffmpeg.wasm requires COOP/COEP headers.");
		console.error("[ASCII-fy] The service worker should set these headers automatically.");
		console.error("[ASCII-fy] Try refreshing the page. If the issue persists, check if you're using HTTPS.");
		throw new Error("SharedArrayBuffer is not available. Please refresh the page and try again. If the issue persists, make sure you're using HTTPS.");
	}

	// Log cross-origin isolation status
	if (typeof window !== 'undefined' && window.crossOriginIsolated) {
		console.log('[ASCII-fy] ✅ Cross-origin isolation is active');
	} else if (typeof self !== 'undefined' && self.crossOriginIsolated) {
		console.log('[ASCII-fy] ✅ Cross-origin isolation is active in worker');
	} else {
		console.warn('[ASCII-fy] ⚠️ Cross-origin isolation status unclear (may cause performance issues)');
	}

	const ffmpegCoreVersion = '0.12.6';
	const primaryCoreUrl = `https://unpkg.com/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.js`;
	const primaryWasmUrl = `https://unpkg.com/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.wasm`;
	const mirrorCoreUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.js`;
	const mirrorWasmUrl = `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${ffmpegCoreVersion}/dist/umd/ffmpeg-core.wasm`;

	console.log('[ASCII-fy] Loading FFmpeg from CDN (this may take 30-60 seconds)...');
	console.log('[ASCII-fy] Downloading ~30MB of WebAssembly files from:', primaryCoreUrl.split('/').slice(0, 3).join('/'));

	// Add progress callback
	let lastLog = 0;
	ffmpeg.on('log', ({ message }) => {
		const now = Date.now();
		// Only log progress messages every 500ms to reduce clutter
		if ((message.includes('Downloading') || message.includes('Loading')) && now - lastLog > 500) {
			console.log('[FFmpeg] ' + message);
			lastLog = now;
		}
	});

	// FFmpeg load with timeout (45 seconds per CDN)
	const LOAD_TIMEOUT = 45000;

	try {
		console.log('[ASCII-fy] Attempting to load from primary CDN (unpkg.com)...');
		console.log('[ASCII-fy] ⏱️ Timeout: 45 seconds...');
		await withTimeout(
			ffmpeg.load({
				coreURL: primaryCoreUrl,
				wasmURL: primaryWasmUrl,
			}),
			LOAD_TIMEOUT,
			'Primary CDN load'
		);
		console.log('[ASCII-fy] ✅ FFmpeg loaded successfully from primary CDN');
	} catch (primaryError) {
		console.warn('[ASCII-fy] ⚠️ Primary CDN failed:', primaryError.message);
		try {
			console.log('[ASCII-fy] Attempting to load from mirror CDN (jsdelivr.net)...');
			console.log('[ASCII-fy] ⏱️ Timeout: 45 seconds...');
			await withTimeout(
				ffmpeg.load({
					coreURL: mirrorCoreUrl,
					wasmURL: mirrorWasmUrl,
				}),
				LOAD_TIMEOUT,
				'Mirror CDN load'
			);
			console.log('[ASCII-fy] ✅ FFmpeg loaded successfully from mirror CDN');
		} catch (mirrorError) {
			console.error('[ASCII-fy] ❌ Both FFmpeg CDNs failed!');
			console.error('[ASCII-fy] Primary error:', primaryError.message);
			console.error('[ASCII-fy] Mirror error:', mirrorError.message);
			console.error('[ASCII-fy] This may be due to:');
			console.error('[ASCII-fy] 1. No internet connection or network issues');
			console.error('[ASCII-fy] 2. CDN service may be down');
			console.error('[ASCII-fy] 3. Browser security restrictions (check COOP/COEP headers)');
			throw new Error('Failed to load FFmpeg. Both CDNs timed out or failed. Check your internet connection and try refreshing the page.');
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
	console.log('[ASCII-fy] Probing video: ' + file.name);
	const ff = await initFFmpeg();
	console.log('[ASCII-fy] FFmpeg ready, writing file to virtual filesystem...');
	const inputName = 'probe_input.' + file.name.split('.').pop();
	await ff.writeFile(inputName, await fetchFile(file));
	console.log('[ASCII-fy] File written, starting probe...');

	let width = 640, height = 480, fps = 30, duration = 0;

	return new Promise(async (resolve) => {
		const logHandler = ({ message }) => {
			// Typical FFmpeg output: "Stream #0:0(und): Video: h264, yuv420p, 1920x1080 [SAR 1:1 DAR 16:9], 30 fps"
			const videoMatch = message.match(/Video: .*?, .*?, (\d+)x(\d+).*?([\d.]+) fps/);
			if (videoMatch) {
				width = parseInt(videoMatch[1], 10);
				height = parseInt(videoMatch[2], 10);
				fps = parseFloat(videoMatch[3]);
				console.log('[ASCII-fy] Detected video: ' + width + 'x' + height + ' @ ' + fps + 'fps');
			}
			// "Duration: 00:00:05.12, start: 0.000000, bitrate: 1234 kb/s"
			const durMatch = message.match(/Duration: (\d+):(\d+):([\d.]+)/);
			if (durMatch) {
				const [h, m, s] = durMatch.slice(1).map(Number);
				duration = (h * 3600) + (m * 60) + s;
				console.log('[ASCII-fy] Detected duration: ' + Math.round(duration) + 's');
			}
		};

		ff.on('log', logHandler);

		try {
			// Run a fast, empty command just to get logs
			console.log('[ASCII-fy] Running FFmpeg probe command...');
			await ff.exec(['-i', inputName, '-f', 'null', '-']);
			console.log('[ASCII-fy] ✅ Probe command completed');
		} catch (e) {
			console.warn("[ASCII-fy] Probe command warning (this is normal):", e.message);
		} finally {
			ff.off('log', logHandler);
			try { await ff.deleteFile(inputName); } catch (e) { }
			console.log('[ASCII-fy] Probe result:', { width, height, fps, duration });
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
