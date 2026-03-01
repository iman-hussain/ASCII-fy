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
let toBlobURL = null;
let AsciiEngine = null;
let CELL_W = null;
let CELL_H = null;

// Helper function to add timeout to a promise
function withTimeout(promise, timeoutMs, label) {
	return Promise.race([
		promise,
		new Promise((_, reject) =>
			setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs / 1000}s`)), timeoutMs)
		)
	]);
}

// Try importing a module from multiple CDN sources with timeout
async function importWithFallback(sources, timeoutMs, label) {
	for (let i = 0; i < sources.length; i++) {
		const url = sources[i];
		const cdn = new URL(url).hostname;
		try {
			console.log(`[ASCII-fy] ${label}: trying ${cdn}...`);
			const mod = await withTimeout(import(url), timeoutMs, `${label} from ${cdn}`);
			console.log(`[ASCII-fy] ✅ ${label}: loaded from ${cdn}`);
			return mod;
		} catch (err) {
			console.warn(`[ASCII-fy] ⚠️ ${label}: ${cdn} failed — ${err.message}`);
			if (i === sources.length - 1) {
				throw new Error(`${label}: all CDN sources failed. Last error: ${err.message}`);
			}
		}
	}
}

async function loadDependencies() {
	if (FFmpeg) return; // Already loaded

	const IMPORT_TIMEOUT = 20000; // 20s per CDN attempt

	try {
		console.log('[ASCII-fy] Loading JavaScript dependencies...');

		const ffmpegModule = await importWithFallback([
			'https://unpkg.com/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js',
			'https://cdn.jsdelivr.net/npm/@ffmpeg/ffmpeg@0.12.6/dist/esm/index.js',
		], IMPORT_TIMEOUT, '@ffmpeg/ffmpeg');
		FFmpeg = ffmpegModule.FFmpeg;

		const utilModule = await importWithFallback([
			'https://unpkg.com/@ffmpeg/util@0.12.1/dist/esm/index.js',
			'https://cdn.jsdelivr.net/npm/@ffmpeg/util@0.12.1/dist/esm/index.js',
		], IMPORT_TIMEOUT, '@ffmpeg/util');
		fetchFile = utilModule.fetchFile;
		toBlobURL = utilModule.toBlobURL;

		const engineModule = await import('./engine.js');
		AsciiEngine = engineModule.AsciiEngine;

		const gifModule = await import('./gif.js');
		CELL_W = gifModule.CELL_W;
		CELL_H = gifModule.CELL_H;

		console.log('[ASCII-fy] ✅ All JavaScript dependencies loaded');
	} catch (err) {
		console.error('[ASCII-fy] ❌ Failed to load dependencies:', err.message);
		throw new Error('Failed to load required modules: ' + err.message);
	}
}

let ffmpeg = null;

async function initFFmpeg() {
	await loadDependencies();

	if (ffmpeg) return ffmpeg;

	// Check for SharedArrayBuffer support (required by modern ffmpeg.wasm)
	if (typeof SharedArrayBuffer === 'undefined') {
		console.error("[ASCII-fy] SharedArrayBuffer is not available. ffmpeg.wasm requires COOP/COEP headers.");
		console.error("[ASCII-fy] Try refreshing the page. If the issue persists, check you're using HTTPS.");
		throw new Error("SharedArrayBuffer is not available. Please refresh and try again.");
	}

	// Log cross-origin isolation status
	const isolated = (typeof self !== 'undefined' && self.crossOriginIsolated);
	console.log(isolated
		? '[ASCII-fy] ✅ Cross-origin isolation is active'
		: '[ASCII-fy] ⚠️ Cross-origin isolation status unclear');

	const v = '0.12.6';
	const cdns = [
		{
			name: 'unpkg.com',
			core:   `https://unpkg.com/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.js`,
			wasm:   `https://unpkg.com/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.wasm`,
			worker: `https://unpkg.com/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.worker.js`,
		},
		{
			name: 'jsdelivr.net',
			core:   `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.js`,
			wasm:   `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.wasm`,
			worker: `https://cdn.jsdelivr.net/npm/@ffmpeg/core@${v}/dist/umd/ffmpeg-core.worker.js`,
		},
	];

	console.log('[ASCII-fy] Loading FFmpeg WASM core (~30 MB)...');
	console.log('[ASCII-fy] Using toBlobURL to pre-fetch (avoids CORS/COEP issues)');

	const LOAD_TIMEOUT = 60000; // 60s per CDN attempt (includes download time for ~30 MB)

	for (let i = 0; i < cdns.length; i++) {
		const cdn = cdns[i];
		console.log(`[ASCII-fy] Trying CDN ${i + 1}/${cdns.length}: ${cdn.name}...`);

		// Fresh instance for every attempt — a failed .load() corrupts internal state
		const ff = new FFmpeg();
		ff.on('log', ({ message }) => { console.log('[FFmpeg] ' + message); });

		try {
			// Pre-fetch all assets into same-origin blob URLs.
			// This avoids CORS/COEP blocking because:
			// 1. Our fetch goes through the coi-serviceworker (adds CORP headers)
			// 2. The resulting blob: URLs are same-origin — no CORS needed
			// 3. ffmpeg's internal Worker can load blob: URLs without issues
			console.log(`[ASCII-fy] Downloading core JS from ${cdn.name}...`);
			const coreBlob = await withTimeout(
				toBlobURL(cdn.core, 'text/javascript'),
				LOAD_TIMEOUT,
				`core JS from ${cdn.name}`
			);

			console.log(`[ASCII-fy] Downloading WASM binary from ${cdn.name}...`);
			const wasmBlob = await withTimeout(
				toBlobURL(cdn.wasm, 'application/wasm'),
				LOAD_TIMEOUT,
				`WASM binary from ${cdn.name}`
			);

			console.log(`[ASCII-fy] Downloading worker JS from ${cdn.name}...`);
			const workerBlob = await withTimeout(
				toBlobURL(cdn.worker, 'text/javascript'),
				LOAD_TIMEOUT,
				`worker JS from ${cdn.name}`
			);

			console.log(`[ASCII-fy] All assets downloaded, initialising FFmpeg...`);
			await ff.load({
				coreURL:   coreBlob,
				wasmURL:   wasmBlob,
				workerURL: workerBlob,
			});

			console.log(`[ASCII-fy] ✅ FFmpeg loaded from ${cdn.name}`);
			ffmpeg = ff;
			return ffmpeg;
		} catch (err) {
			console.warn(`[ASCII-fy] ⚠️ ${cdn.name} failed: ${err.message}`);
		}
	}

	// All CDNs exhausted
	console.error('[ASCII-fy] ❌ All FFmpeg CDN sources failed!');
	console.error('[ASCII-fy] Tried:', cdns.map(c => c.name).join(', '));
	throw new Error('Failed to load FFmpeg from all CDN sources. Check your internet connection.');
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
			ffmpeg = null;  // Reset so next call creates a fresh instance
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
