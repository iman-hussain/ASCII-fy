/**
 * ASCII-fi – WASM Background Worker
 *
 * Runs the web-converter logic (which includes ffmpeg.wasm)
 * in a separate thread so the GUI doesn't freeze during processing.
 */

// Import the converter logic built for the web
// (Assuming we bundle this or use ES modules in the worker)
import { convertWeb, probeVideoWeb } from '../../../lib/web-converter.js';

let abortController = null;

self.onmessage = async (e) => {
	const { type, payload } = e.data;

	if (type === 'PROBE') {
		try {
			const info = await probeVideoWeb(payload.file);
			self.postMessage({ type: 'PROBE_SUCCESS', info });
		} catch (err) {
			self.postMessage({ type: 'PROBE_ERROR', error: err.message });
		}
	}

	if (type === 'CONVERT') {
		abortController = new AbortController();
		try {
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
			self.postMessage({ type: 'CONVERT_SUCCESS', result });
		} catch (err) {
			if (err.message === 'Aborted') {
				self.postMessage({ type: 'CONVERT_ABORTED' });
			} else {
				self.postMessage({ type: 'CONVERT_ERROR', error: err.message });
			}
		} finally {
			abortController = null;
		}
	}

	if (type === 'ABORT') {
		if (abortController) {
			abortController.abort();
		}
	}
};
