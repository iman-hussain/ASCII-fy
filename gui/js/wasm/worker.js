/**
 * ASCII-fi – WASM Background Worker
 *
 * Runs the web-converter logic (which includes ffmpeg.wasm)
 * in a separate thread so the GUI doesn't freeze during processing.
 */

// Intercept console in worker to send logs to main thread
const originalConsole = {
	log: console.log,
	error: console.error,
	warn: console.warn,
	info: console.info
};

function safeStringify(val) {
	if (val instanceof Error) return val.message || String(val);
	if (typeof val === 'object' && val !== null) {
		try { return JSON.stringify(val); } catch { return String(val); }
	}
	return String(val);
}

console.log = function(...args) {
	originalConsole.log.apply(console, args);
	try {
		const msg = args.map(safeStringify).join(' ');
		self.postMessage({ type: 'LOG', level: 'info', message: msg });
	} catch (e) {
		// Fail silently
	}
};

console.error = function(...args) {
	originalConsole.error.apply(console, args);
	try {
		const msg = args.map(safeStringify).join(' ');
		self.postMessage({ type: 'LOG', level: 'error', message: msg });
	} catch (e) {
		// Fail silently
	}
};

console.warn = function(...args) {
	originalConsole.warn.apply(console, args);
	try {
		const msg = args.map(safeStringify).join(' ');
		self.postMessage({ type: 'LOG', level: 'warning', message: msg });
	} catch (e) {
		// Fail silently
	}
};

console.info = function(...args) {
	originalConsole.info.apply(console, args);
	try {
		const msg = args.map(safeStringify).join(' ');
		self.postMessage({ type: 'LOG', level: 'info', message: msg });
	} catch (e) {
		// Fail silently
	}
};

console.log('[Worker] Worker script loaded, preparing to import modules...');

// Lazy-load modules to catch import errors
let convertWeb, probeVideoWeb, generateBundle, createAsciiGifWriter;
let modulesLoaded = false;

async function loadModules() {
	if (modulesLoaded) return;
	try {
		console.log('[Worker] Importing web-converter...');
		const webConverter = await import('../../../lib/web-converter.js');
		convertWeb = webConverter.convertWeb;
		probeVideoWeb = webConverter.probeVideoWeb;

		console.log('[Worker] Importing bundler...');
		const bundler = await import('../../../lib/bundler.js');
		generateBundle = bundler.generateBundle;

		console.log('[Worker] Importing gif...');
		const gif = await import('../../../lib/gif.js');
		createAsciiGifWriter = gif.createAsciiGifWriter;

		modulesLoaded = true;
		console.log('[Worker] All modules loaded successfully');
	} catch (err) {
		console.error('[Worker] Failed to load modules:', err);
		throw new Error('Failed to load worker modules: ' + err.message);
	}
}

let abortController = null;
let currentOperation = null; // Track whether we're doing PROBE or CONVERT

self.onerror = (err) => {
	console.error('[Worker] Global error:', err);
	const errorMsg = 'Worker error: ' + (err.message || String(err));
	if (currentOperation === 'CONVERT') {
		self.postMessage({ type: 'CONVERT_ERROR', error: errorMsg });
	} else {
		self.postMessage({ type: 'PROBE_ERROR', error: errorMsg });
	}
};

self.onmessage = async (e) => {
	const { type, payload } = e.data;

	if (type === 'PROBE') {
		currentOperation = 'PROBE';
		try {
			console.log('[Worker] Received PROBE message, loading modules...');
			await loadModules();
			console.log('[Worker] Starting video probe...');
			const info = await probeVideoWeb(payload.file);
			console.log('[Worker] Probe successful:', info);
			self.postMessage({ type: 'PROBE_SUCCESS', info });
		} catch (err) {
			console.error('[Worker] Probe failed:', err);
			self.postMessage({ type: 'PROBE_ERROR', error: err.message || String(err) });
		} finally {
			currentOperation = null;
		}
	}

	if (type === 'CONVERT') {
		currentOperation = 'CONVERT';
		abortController = new AbortController();
		try {
			console.log('[Worker] Received CONVERT message, loading modules...');
			await loadModules();

			// Proxy the onFrame callback to send progress back to main thread
			const options = {
				...payload.options,
				file: payload.file,
				signal: abortController.signal,
				onFrame: (index, frame) => {
					self.postMessage({ type: 'PROGRESS', index, chars: frame.chars });
				}
			};

			const result = await convertWeb(options);

			self.postMessage({ type: 'STATUS', message: 'Packaging Bundle... Please wait' });
			const bundleData = await generateBundle({
				frames: result.frames,
				width: result.width,
				height: result.height,
				fps: result.fps,
				color: options.color,
				qStep: options.qStep,
				render: options.render,
				outputDir: null // Web mode doesn't write to disk
			});

			self.postMessage({ type: 'STATUS', message: 'Encoding GIF... Please wait' });
			const gifWriter = await createAsciiGifWriter({
				width: result.width,
				height: result.height,
				fps: result.fps,
				render: options.render,
				outputPath: null // Web mode doesn't write to disk
			});
			for (const frame of result.frames) {
				gifWriter.writeFrame(frame);
			}
			const gifData = await gifWriter.finalize();

			result.bundle = {
				bundleJS: bundleData.bundleJS,
				demoHTML: bundleData.demoHTML,
				stats: bundleData.stats
			};
			if (gifData) {
				result.gif = {
					buffer: gifData.buffer,
					width: gifData.width,
					height: gifData.height
				};
			}

			self.postMessage({ type: 'CONVERT_SUCCESS', result });
		} catch (err) {
			console.error('[Worker] Convert error:', err);
			if (err.message === 'Aborted') {
				self.postMessage({ type: 'CONVERT_ABORTED' });
			} else {
				self.postMessage({ type: 'CONVERT_ERROR', error: err.message });
			}
		} finally {
			abortController = null;
			currentOperation = null;
		}
	}

	if (type === 'ABORT') {
		if (abortController) {
			abortController.abort();
		}
	}
};
