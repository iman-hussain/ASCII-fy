/**
 * ascii-fy – Lightweight GUI server.
 *
 * Spins up a local HTTP server on a random port, serves the GUI page, and
 * opens the default browser.  Zero extra dependencies — uses only Node built-ins
 * plus the existing lib/ modules.
 *
 * Start:  node gui/server.js
 */

import http from 'node:http';
import { readFile, access, mkdir, stat, readdir } from 'node:fs/promises';
import { createReadStream, createWriteStream } from 'node:fs';
import { resolve, join, extname, basename, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import ffmpeg from 'ffmpeg-static';

import { convert, probeVideo } from '../lib/converter.js';
import { createBundleWriter } from '../lib/bundler.js';
import { createAsciiGifWriter } from '../lib/gif.js';
import { makeGradientPalette, makeGrayscalePalette, makeRealisticPalette } from '../lib/render.js';
import { adaptiveTone, sampleVideoLuminance } from '../lib/tone.js';
import { extractPaletteFromVideo } from '../lib/kmeans.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ROOT = resolve(__dirname, '..');

const ML_MODEL_URL = process.env.ASCII_FY_MODEL_URL
	|| 'https://huggingface.co/onnx-community/mediapipe_selfie_segmentation/resolve/main/onnx/model.onnx';

/**
 * Download the ML segmentation model to the given path.
 * Returns true on success, false on failure.
 */
async function downloadMlModel(destPath) {
	const https = await import('node:https');
	const http = await import('node:http');
	const { dirname: d } = await import('node:path');
	await mkdir(d(destPath), { recursive: true });

	return new Promise((resolve) => {
		const timeout = setTimeout(() => {
			console.error('ML model download timed out.');
			resolve(false);
		}, 60000); // 1 minute timeout

		const get = (url, redirects = 5) => {
			const mod = url.startsWith('https') ? https : http;
			mod.get(url, { headers: { 'User-Agent': 'ascii-fy' } }, (res) => {
				if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && redirects > 0) {
					res.resume();
					return get(res.headers.location, redirects - 1);
				}
				if (res.statusCode !== 200) { res.resume(); clearTimeout(timeout); return resolve(false); }
				const ws = createWriteStream(destPath);
				res.pipe(ws);
				ws.on('finish', () => { clearTimeout(timeout); resolve(true); });
				ws.on('error', () => { clearTimeout(timeout); resolve(false); });
				res.on('error', () => { clearTimeout(timeout); resolve(false); });
			}).on('error', () => { clearTimeout(timeout); resolve(false); });
		};
		get(ML_MODEL_URL);
	});
}

/* ── Palette presets ───────────────────────────────────────────────── */

const gradientPresets = {
	realistic: [[12, 18, 30], [40, 80, 140], [120, 160, 120], [200, 170, 120], [220, 220, 210]],
	grayscale: [[0, 0, 0], [255, 255, 255]],
	sunset: [[255, 94, 58], [255, 149, 0], [255, 204, 0]],
	ocean: [[0, 24, 72], [0, 118, 255], [0, 217, 255]],
	neon: [[57, 255, 20], [0, 255, 255], [255, 0, 255]],
	forest: [[16, 64, 32], [34, 139, 34], [154, 205, 50]],
};

function buildPresetPalette(name, count) {
	if (name === 'grayscale') return makeGrayscalePalette(count);
	if (name === 'realistic') return makeRealisticPalette(count);
	return makeGradientPalette(gradientPresets[name] || gradientPresets.realistic, count);
}

function safeOutputName(inputPath) {
	return basename(inputPath, extname(inputPath)).replace(/[<>:"/\\|?*]+/g, '_').trim() || 'output';
}

function buildOutputName(inputPath, { mode, depth, palette, width, fps, charMode, outlineOnly }) {
	const parts = [safeOutputName(inputPath), mode || 'truecolor'];
	if ((mode === 'palette' || mode === 'kmeans' || mode === 'grayscale') && depth) parts.push(`${depth}c`);
	if (mode === 'palette' && palette) parts.push(palette);
	if (width) parts.push(`${width}w`);
	if (fps) parts.push(`${fps}fps`);
	parts.push(charMode || 'ascii');
	if (outlineOnly) parts.push('outline');
	return parts.join('_');
}

/* ── Active SSE connections ────────────────────────────────────────── */

const VIDEO_EXTS = new Set(['.mp4', '.webm', '.gif', '.mov', '.avi', '.mkv', '.flv']);

/**
 * Resolve a video path – accepts:
 *   - Full absolute path
 *   - Relative path from project root
 *   - Just a filename → searched in ./input/
 */
async function resolveVideoPath(raw) {
	if (!raw) return null;

	// Try as-is (absolute or relative to cwd)
	const candidates = [
		resolve(raw),
		join(ROOT, raw),
		join(ROOT, 'input', raw),
	];

	for (const p of candidates) {
		try { await access(p); return p; } catch { }
	}

	// Try scanning input/ for a case-insensitive match
	try {
		const entries = await readdir(join(ROOT, 'input'));
		const lower = raw.toLowerCase();
		const match = entries.find(e => e.toLowerCase() === lower);
		if (match) return join(ROOT, 'input', match);
	} catch { }

	return null;
}

const sseClients = new Set();

function broadcast(event, data) {
	const msg = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
	for (const res of sseClients) {
		try { res.write(msg); } catch { sseClients.delete(res); }
	}
}

/* ── Conversion engine ─────────────────────────────────────────────── */

let converting = false;
let currentAbort = null;   // AbortController for the active conversion

async function runConversion(opts) {
	console.log('[server] runConversion started with opts:', JSON.stringify(opts));
	if (converting) {
		console.warn('[server] Conversion already in progress.');
		throw new Error('A conversion is already in progress.');
	}
	converting = true;
	const ac = new AbortController();
	currentAbort = ac;

	try {
		const {
			inputPath,
			width = 100,
			height,
			fps = 24,
			mode = 'truecolor',
			charMode = 'ascii',
			depth = 16,
			palette = 'realistic',
			fg = '#00ff00',
			bg = '#000000',
			playerBg = '',
			start,
			end,
			outlineOnly = false,
			skipGif = false,
			foreground: _fgRaw = null,
		} = opts;
		let foreground = _fgRaw;

		broadcast('log', { msg: 'Probing video…' });
		console.log('[server] Probing video:', inputPath);
		let meta;
		try { meta = await probeVideo(inputPath); }
		catch (err) {
			console.error('[server] Probe failed:', err.message);
			meta = { fps: 24, width: 640, height: 480, duration: undefined };
		}
		console.log('[server] Video probe result:', JSON.stringify(meta));

		const inputExt = extname(inputPath).toLowerCase();

		/* Resolve player background colour */
		let resolvedBg = '#000000';
		if (playerBg === 'auto') {
			try {
				console.log('[server] Sampling video luminance for auto background...');
				const bgStats = await sampleVideoLuminance(inputPath, width, meta);
				resolvedBg = bgStats.mean > 0.6 ? '#f0f0f0' : bgStats.mean > 0.4 ? '#1a1a2e' : '#0a0a0a';
				broadcast('log', { msg: `Auto background: ${resolvedBg}` });
				console.log('[server] Auto background detected:', resolvedBg);
			} catch (err) {
				console.error('[server] Auto background detection failed:', err.message);
			}
		} else if (playerBg && /^#[0-9a-fA-F]{6}$/.test(playerBg)) {
			resolvedBg = playerBg;
		}

		const effectiveFps = fps || meta.fps || 24;
		const duration = typeof end === 'number'
			? Math.max(0, end - (start || 0))
			: meta.duration;
		const expectedFrames = duration && effectiveFps
			? Math.max(1, Math.round(duration * effectiveFps)) : null;

		/* Build render config */
		broadcast('log', { msg: 'Building configuration…' });
		let render, tone;

		if (mode === 'mono') {
			render = {
				mode: 'mono', palette: null, charMode,
				theme: { fg: fg || '#00ff00', bg: bg || '#000000' }, label: 'Monochrome'
			};
			tone = { contrast: 1.15, brightness: 0.02, saturation: 1.0, gamma: 1.05 };
		} else if (mode === 'grayscale') {
			const pal = makeGrayscalePalette(depth);
			broadcast('log', { msg: 'Sampling video for adaptive tone…' });
			console.log('[server] Sampling video for adaptive tone (grayscale)...');
			const stats = await sampleVideoLuminance(inputPath, width, meta, opts.crop);
			tone = adaptiveTone(depth, stats, inputExt, opts.customTone);
			tone.saturation = 0;
			render = {
				mode: 'palette', palette: pal, charMode,
				theme: { fg: '#111', bg: resolvedBg }, label: `Grayscale (${depth} shades)`
			};
		} else if (mode === 'palette') {
			const pal = buildPresetPalette(palette, depth);
			broadcast('log', { msg: 'Sampling video for adaptive tone…' });
			console.log('[server] Sampling video for adaptive tone (palette)...');
			const stats = await sampleVideoLuminance(inputPath, width, meta, opts.crop);
			tone = adaptiveTone(depth, stats, inputExt, opts.customTone);
			render = {
				mode: 'palette', palette: pal, charMode,
				theme: { fg: '#111', bg: resolvedBg }, label: `${palette} (${depth} colours)`
			};
		} else if (mode === 'kmeans') {
			broadcast('log', { msg: `Extracting ${depth}-colour palette via k-means…` });
			console.log('[server] Extracting palette via k-means...');
			const pal = await extractPaletteFromVideo(inputPath, width, meta, depth, opts.crop);
			console.log('[server] Sampling video for adaptive tone (kmeans)...');
			const stats = await sampleVideoLuminance(inputPath, width, meta, opts.crop);
			tone = adaptiveTone(depth, stats, inputExt, opts.customTone);
			render = {
				mode: 'palette', palette: pal || makeGrayscalePalette(depth), charMode,
				theme: { fg: '#111', bg: resolvedBg },
				label: pal ? `k-means (${depth})` : `Grayscale fallback (${depth})`
			};
		} else {
			render = {
				mode: 'truecolor', palette: null, charMode,
				theme: { fg: '#111', bg: resolvedBg }, label: 'Truecolor (source)'
			};

			tone = inputExt === '.gif'
				? { contrast: 1.35, brightness: 0.04, saturation: 1.2, gamma: 1.1 }
				: { contrast: 1.15, brightness: 0.02, saturation: 1.05, gamma: 1.05 };

			// Apply user brightness/contrast adjustments on top of base tone
			if (opts.customTone) {
				if (typeof opts.customTone.brightness === 'number') {
					tone.brightness += opts.customTone.brightness / 100;
				}
				if (typeof opts.customTone.contrast === 'number') {
					if (opts.customTone.contrast < 0) {
						tone.contrast *= (100 + opts.customTone.contrast) / 100;
					} else {
						tone.contrast += (opts.customTone.contrast / 100) * 2;
					}
				}
			}
			tone.brightness = Math.max(-1.0, Math.min(1.0, tone.brightness));
			tone.contrast = Math.max(-2.0, Math.min(100.0, tone.contrast));
		}

		if (foreground && render?.theme) {
			if (foreground.background === 'transparent') {
				render.theme.bg = 'transparent';
			} else if (foreground.background === 'solid' && foreground.bg) {
				render.theme.bg = foreground.bg;
			}
			if (foreground.mode === 'ml') {
				if (!foreground.modelPath) {
					foreground.modelPath = join(ROOT, 'models', 'selfie.onnx');
				}
				try {
					await access(foreground.modelPath);
				} catch {
					// Try to download the model automatically
					broadcast('log', { msg: 'ML model not found — attempting automatic download…' });
					const downloaded = await downloadMlModel(foreground.modelPath);
					if (!downloaded) {
						broadcast('log', { msg: '⚠ ML model download failed. Falling back to Motion mask mode.' });
						foreground = { ...foreground, mode: 'motion' };
					} else {
						broadcast('log', { msg: '✓ ML model downloaded successfully.' });
					}
				}
			}
			broadcast('log', { msg: `Foreground isolation: ${foreground.mode} mode, ${foreground.background} background` });
		}

		/* Output directory */
		const outputDir = join(ROOT, 'output');
		const outputJobDir = join(outputDir, safeOutputName(inputPath));
		await mkdir(outputJobDir, { recursive: true });

		/* Convert frames */
		broadcast('log', { msg: 'Converting frames…' });
		const includeColors = mode !== 'mono';
		const gifPath = join(outputJobDir, 'preview.gif');
		let bundleWriter = null;
		let gifWriter = null;
		let frameCount = 0;

		const result = await convert({
			inputPath, outputWidth: width, outputHeight: height, color: includeColors,
			startTime: start, endTime: end, meta, targetFps: fps, tone, charMode,
			collectFrames: false,
			foreground,
			outlineOnly,
			crop: opts.crop || null,
			signal: ac.signal,
			onFrame: (idx, frame) => {
				frameCount = idx + 1;
				broadcast('progress', {
					frame: frameCount, total: expectedFrames,
					percent: expectedFrames ? Math.min(100, Math.round((frameCount / expectedFrames) * 100)) : null,
				});

				if (!bundleWriter) {
					// Use the first frame to determine the output height
					const fh = Math.max(1, Math.round(frame.chars.length / width));
					bundleWriter = createBundleWriter({
						width, height: fh, fps: effectiveFps,
						color: includeColors, outputDir: outputJobDir, render
					});
					if (!skipGif) {
						gifWriter = createAsciiGifWriter({
							width, height: fh, fps: effectiveFps,
							render, outputPath: gifPath
						});
					}
				}
				bundleWriter.writeFrame(frame);
				if (gifWriter) gifWriter.writeFrame(frame);
			},
		});

		/* Finalize */
		let gifOk = false;
		if (gifWriter) {
			broadcast('log', { msg: 'Generating GIF…' });
			broadcast('progress', { phase: 'gif', percent: 100 });
			try { await gifWriter.finalize(); gifOk = true; } catch { }
		}

		broadcast('log', { msg: 'Generating web bundle…' });
		broadcast('progress', { phase: 'bundle', percent: 100 });
		const bundleInfo = bundleWriter ? await bundleWriter.finalize() : null;

		let gifSize = 0;
		if (gifOk) {
			try { gifSize = (await stat(gifPath)).size; } catch { }
		}

		const summary = {
			ok: true,
			frames: frameCount,
			width: result.width,
			height: result.height,
			fps: effectiveFps,
			outputDir: outputJobDir,
			gifPath: gifOk ? gifPath : null,
			gifUrl: gifOk ? '/' + relative(ROOT, gifPath).split(/[\\/]/).map(encodeURIComponent).join('/') : null,
			gifSize,
			htmlPath: bundleInfo?.htmlPath || null,
			htmlUrl: bundleInfo?.htmlPath ? '/' + relative(ROOT, bundleInfo.htmlPath).split(/[\\/]/).map(encodeURIComponent).join('/') : null,
			bundlePath: bundleInfo?.bundlePath || null,
			bundleUrl: bundleInfo?.bundlePath ? '/' + relative(ROOT, bundleInfo.bundlePath).split(/[\\/]/).map(encodeURIComponent).join('/') : null,
			bundleSize: bundleInfo?.stats?.bundleSize || 0,
			gzipRatio: bundleInfo?.stats?.gzipRatio || '?',
			totalFrames: bundleInfo?.stats?.totalFrames || frameCount,
		};
		broadcast('done', summary);
		return summary;
	} catch (err) {
		const msg = ac.signal.aborted ? 'Conversion stopped by user.' : err.message;
		const fail = { ok: false, error: msg };
		broadcast('done', fail);
		return fail;
	} finally {
		converting = false;
		currentAbort = null;
	}
}

/* ── HTTP handler ──────────────────────────────────────────────────── */

const MIME = {
	'.html': 'text/html',
	'.js': 'application/javascript',
	'.css': 'text/css',
	'.json': 'application/json',
	'.gif': 'image/gif',
	'.png': 'image/png',
	'.svg': 'image/svg+xml',
	'.mp4': 'video/mp4',
	'.webm': 'video/webm',
	'.mov': 'video/quicktime',
	'.avi': 'video/x-msvideo',
	'.mkv': 'video/x-matroska',
};

async function handler(req, res) {
	try {
		const url = new URL(req.url, `http://${req.headers.host}`);

		/* SSE stream for progress updates */
		if (url.pathname === '/events') {
			res.writeHead(200, {
				'Content-Type': 'text/event-stream',
				'Cache-Control': 'no-cache',
				'Connection': 'keep-alive',
			});
			res.write(':\n\n'); // ping
			console.log('[server] New SSE client connected. Total clients:', sseClients.size + 1);
			sseClients.add(res);
			req.on('close', () => {
				sseClients.delete(res);
				console.log('[server] SSE client disconnected. Remaining:', sseClients.size);
			});
			return;
		}

		/* API: probe video – accepts full path or just a filename (searches input/) */
		if (url.pathname === '/api/probe' && req.method === 'POST') {
			const body = await readBody(req);
			try {
				const { path: rawPath } = JSON.parse(body);
				const resolved = await resolveVideoPath(rawPath);
				if (!resolved) {
					json(res, {
						ok: false, error: 'File not found', resolvedPath: null,
						meta: { width: 640, height: 480, fps: 24, duration: undefined }
					});
					return;
				}
				const meta = await probeVideo(resolved);
				let fileSize = 0;
				try { fileSize = (await stat(resolved)).size; } catch { }
				json(res, { ok: true, resolvedPath: resolved, meta, fileSize });
			} catch (err) {
				json(res, {
					ok: false, error: err.message, resolvedPath: null,
					meta: { width: 640, height: 480, fps: 24, duration: undefined }
				});
			}
			return;
		}

		/* API: abort conversion */
		if (url.pathname === '/api/abort' && req.method === 'POST') {
			if (currentAbort) {
				currentAbort.abort();
				json(res, { ok: true });
			} else {
				json(res, { ok: false, error: 'No conversion in progress.' });
			}
			return;
		}

		/* API: start conversion */
		if (url.pathname === '/api/convert' && req.method === 'POST') {
			const body = await readBody(req);
			try {
				const opts = JSON.parse(body);
				// Resolve the input path before conversion
				const resolved = await resolveVideoPath(opts.inputPath);
				if (!resolved) {
					json(res, { ok: false, error: `File not found: ${opts.inputPath}` });
					return;
				}
				opts.inputPath = resolved;
				// Fire-and-forget — progress comes over SSE
				console.log('[server] Starting conversion in background...');
				runConversion(opts).catch(err => {
					console.error('[server] Background conversion error:', err);
				});
				json(res, { ok: true, started: true });
			} catch (err) {
				json(res, { ok: false, error: err.message });
			}
			return;
		}



		/* API: palette preview – returns generated palette colors */
		if (url.pathname === '/api/palette-preview' && req.method === 'POST') {
			const body = await readBody(req);
			try {
				const { palette, depth, mode, inputPath, width } = JSON.parse(body);
				let colors;
				if (mode === 'kmeans' && inputPath) {
					const resolved = await resolveVideoPath(inputPath);
					if (resolved) {
						let meta;
						try { meta = await probeVideo(resolved); }
						catch { meta = { fps: 24, width: 640, height: 480, duration: undefined }; }
						colors = await extractPaletteFromVideo(resolved, width || 80, meta, depth || 16);
					}
				}
				if (!colors) {
					colors = buildPresetPalette(palette || 'realistic', depth || 16);
				}
				json(res, { ok: true, colors });
			} catch (err) {
				json(res, { ok: false, error: err.message });
			}
			return;
		}

		/* API: single-frame preview – renders one frame as ASCII HTML */
		if (url.pathname === '/api/preview-frame' && req.method === 'POST') {
			const body = await readBody(req);
			try {
				const opts = JSON.parse(body);
				const resolved = await resolveVideoPath(opts.inputPath);
				if (!resolved) { json(res, { ok: false, error: 'File not found' }); return; }

				let meta;
				try { meta = await probeVideo(resolved); }
				catch { meta = { fps: 24, width: 640, height: 480, duration: undefined }; }

				const w = opts.width || 80;
				const mode = opts.mode || 'truecolor';
				const depth = opts.depth || 16;
				const palette = opts.palette || 'realistic';
				const charMode = opts.charMode || 'ascii';
				const outlineOnly = !!opts.outlineOnly;
				const midTime = opts.time != null ? opts.time
					: (meta.duration ? meta.duration / 2 : 1);

				/* Build render config (same logic as runConversion) */
				const inputExt = extname(resolved).toLowerCase();
				let render, tone;
				if (mode === 'mono') {
					render = {
						mode: 'mono', palette: null, charMode,
						theme: { fg: opts.fg || '#00ff00', bg: opts.bg || '#000000' }
					};
					tone = { contrast: 1.15, brightness: 0.02, saturation: 1.0, gamma: 1.05 };
				} else if (mode === 'grayscale') {
					const pal = makeGrayscalePalette(depth);
					const stats = await sampleVideoLuminance(resolved, w, meta);
					tone = adaptiveTone(depth, stats, inputExt);
					tone.saturation = 0;
					render = { mode: 'palette', palette: pal, charMode, theme: { fg: '#111', bg: '#000' } };
				} else if (mode === 'palette') {
					const pal = buildPresetPalette(palette, depth);
					const stats = await sampleVideoLuminance(resolved, w, meta);
					tone = adaptiveTone(depth, stats, inputExt);
					render = { mode: 'palette', palette: pal, charMode, theme: { fg: '#111', bg: '#000' } };
				} else if (mode === 'kmeans') {
					const pal = await extractPaletteFromVideo(resolved, w, meta, depth);
					const stats = await sampleVideoLuminance(resolved, w, meta);
					tone = adaptiveTone(depth, stats, inputExt);
					render = { mode: 'palette', palette: pal || makeGrayscalePalette(depth), charMode, theme: { fg: '#111', bg: '#000' } };
				} else {
					render = { mode: 'truecolor', palette: null, charMode, theme: { fg: '#111', bg: '#000' } };
					tone = inputExt === '.gif'
						? { contrast: 1.35, brightness: 0.04, saturation: 1.2, gamma: 1.1 }
						: { contrast: 1.15, brightness: 0.02, saturation: 1.05, gamma: 1.05 };
				}

				let capturedFrame = null;
				await convert({
					inputPath: resolved,
					outputWidth: w,
					outputHeight: opts.height, // Added outputHeight
					color: mode !== 'mono',
					startTime: midTime,
					endTime: midTime + 0.1,
					meta,
					targetFps: 1,
					tone,
					charMode,
					outlineOnly,
					collectFrames: false,
					onFrame: (idx, frame) => {
						if (!capturedFrame) capturedFrame = frame;
					},
				});

				if (!capturedFrame) { json(res, { ok: false, error: 'No frames captured' }); return; }

				/* Build simple HTML snippet for the single frame */
				const { chars, colors: frameColors } = capturedFrame;
				const rows = [];
				const h = Math.ceil(chars.length / w);
				for (let y = 0; y < h; y++) {
					let rowHtml = '';
					for (let x = 0; x < w; x++) {
						const i = y * w + x;
						const ch = chars[i] || ' ';
						const esc = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
						if (frameColors && frameColors[i]) {
							const [r, g, b] = frameColors[i];
							rowHtml += '<span style="color:rgb(' + r + ',' + g + ',' + b + ')">' + esc + '</span>';
						} else {
							rowHtml += esc;
						}
					}
					rows.push(rowHtml);
				}
				const html = rows.join('\n');

				json(res, { ok: true, html, width: w, height: h });
			} catch (err) {
				json(res, { ok: false, error: err.message });
			}
			return;
		}

		/* API: list video files in input/ */
		if (url.pathname === '/api/files' && req.method === 'GET') {
			try {
				const entries = await readdir(join(ROOT, 'input'));
				const videos = entries.filter(e => VIDEO_EXTS.has(extname(e).toLowerCase()));
				json(res, { ok: true, files: videos });
			} catch {
				json(res, { ok: true, files: [] });
			}
			return;
		}

		/* API: open file / folder */
		if (url.pathname === '/api/open' && req.method === 'POST') {
			const body = await readBody(req);
			const { path: p } = JSON.parse(body);
			openPath(p);
			json(res, { ok: true });
			return;
		}

		/* API: upload video (drag-and-drop doesn't expose full paths in browsers) */
		if (url.pathname === '/api/upload' && req.method === 'POST') {
			const rawName = decodeURIComponent(req.headers['x-filename'] || 'upload.mp4');
			const safeName = rawName.replace(/[<>:"/\\|?*]+/g, '_');
			const inputDir = join(ROOT, 'input');
			await mkdir(inputDir, { recursive: true });
			const destPath = join(inputDir, safeName);
			try {
				await new Promise((resolve, reject) => {
					const ws = createWriteStream(destPath);
					req.pipe(ws);
					ws.on('finish', resolve);
					ws.on('error', reject);
					req.on('error', reject);
				});
				json(res, { ok: true, resolvedPath: destPath, filename: safeName });
			} catch (err) {
				json(res, { ok: false, error: err.message });
			}
			return;
		}

		/* API: stream a video file for browser preview */
		if (url.pathname === '/api/video' && req.method === 'GET') {
			const videoPath = url.searchParams.get('path');
			if (!videoPath) { res.writeHead(400); res.end('Missing path'); return; }
			try {
				const st = await stat(videoPath);
				const ext = extname(videoPath).toLowerCase();
				const ct = MIME[ext] || 'application/octet-stream';
				const range = req.headers.range;
				if (range) {
					const [s, e] = range.replace(/bytes=/, '').split('-');
					const start = parseInt(s, 10);
					const end = e ? parseInt(e, 10) : st.size - 1;
					res.writeHead(206, {
						'Content-Range': `bytes ${start}-${end}/${st.size}`,
						'Accept-Ranges': 'bytes',
						'Content-Length': end - start + 1,
						'Content-Type': ct,
					});
					createReadStream(videoPath, { start, end }).pipe(res);
				} else {
					res.writeHead(200, { 'Content-Length': st.size, 'Content-Type': ct, 'Accept-Ranges': 'bytes' });
					createReadStream(videoPath).pipe(res);
				}
			} catch {
				res.writeHead(404); res.end('Not found');
			}
			return;
		}

		/* Serve output files (GIF, HTML, bundle) */
		if (url.pathname.startsWith('/output/')) {
			const relPath = decodeURIComponent(url.pathname.slice(1));
			const filePath = join(ROOT, relPath);
			const outputBase = join(ROOT, 'output');
			if (!filePath.startsWith(outputBase)) { res.writeHead(403); res.end('Forbidden'); return; }
			try {
				const st = await stat(filePath);
				const ext = extname(filePath).toLowerCase();
				const ct = MIME[ext] || 'application/octet-stream';
				res.writeHead(200, { 'Content-Type': ct, 'Content-Length': st.size });
				createReadStream(filePath).pipe(res);
			} catch {
				res.writeHead(404); res.end('Not found');
			}
			return;
		}

		/* Serve static: gui/index.html, style.css, app.js */
		if (url.pathname === '/' || url.pathname === '/index.html') {
			const html = await readFile(join(__dirname, 'index.html'), 'utf-8');
			res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
			res.end(html);
			return;
		}

		if (url.pathname === '/style.css') {
			const css = await readFile(join(__dirname, 'style.css'), 'utf-8');
			res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8' });
			res.end(css);
			return;
		}

		if (url.pathname === '/app.js' || url.pathname.startsWith('/js/')) {
			try {
				const relPath = url.pathname.replace(/^\/+/, '');
				const js = await readFile(join(__dirname, relPath), 'utf-8');
				res.writeHead(200, {
					'Content-Type': 'application/javascript; charset=utf-8',
					'Cache-Control': 'no-cache, no-store, must-revalidate'
				});
				res.end(js);
			} catch (err) {
				res.writeHead(404, { 'Content-Type': 'text/plain' });
				res.end('Not found');
			}
			return;
		}

		/* 404 */
		res.writeHead(404, { 'Content-Type': 'text/plain' });
		res.end('Not found');

	} catch (err) {
		/* Top-level catch — guarantees a response is always sent */
		if (!res.headersSent) {
			res.writeHead(500, { 'Content-Type': 'application/json' });
			res.end(JSON.stringify({ ok: false, error: err.message }));
		}
	}
}

function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		req.on('data', c => chunks.push(c));
		req.on('end', () => resolve(Buffer.concat(chunks).toString()));
		req.on('error', reject);
	});
}

function json(res, data) {
	const body = JSON.stringify(data);
	res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
	res.end(body);
}

function openPath(p) {
	const plat = process.platform;
	if (plat === 'win32') spawn('cmd', ['/c', 'start', '', p], { stdio: 'ignore', detached: true });
	else if (plat === 'darwin') spawn('open', [p], { stdio: 'ignore', detached: true });
	else spawn('xdg-open', [p], { stdio: 'ignore', detached: true });
}

/* ── Start server ──────────────────────────────────────────────────── */

const PORT = parseInt(process.env.PORT) || 0; // 0 = random available port
const server = http.createServer(handler);

server.listen(PORT, '127.0.0.1', () => {
	const addr = server.address();
	const url = `http://127.0.0.1:${addr.port}`;
	console.log(`\n  ascii-fy GUI → ${url}\n`);
	openPath(url);
});
