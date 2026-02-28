import { access, mkdir } from 'node:fs/promises';
import { resolve, extname, basename, join } from 'node:path';
import { convert, probeVideo } from './converter.js';
import { createBundleWriter } from './bundler.js';
import { createAsciiGifWriter } from './gif.js';
import { makeGradientPalette, makeGrayscalePalette, makeRealisticPalette } from './render.js';
import { adaptiveTone, sampleVideoLuminance } from './tone.js';
import { extractPaletteFromVideo } from './kmeans.js';

export function safeOutputName(inputPath) {
	const base = basename(inputPath, extname(inputPath));
	return base.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'output';
}

export function parseHexColor(hex, fallback) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
	if (!m) return fallback;
	return `#${m[1].toLowerCase()}`;
}

export function hexToRgbArray(hex, fallback) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
	if (!m) return fallback;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export const gradientPresets = {
	realistic: [[12, 18, 30], [40, 80, 140], [120, 160, 120], [200, 170, 120], [220, 220, 210]],
	grayscale: [[0, 0, 0], [255, 255, 255]],
	sunset: [[255, 94, 58], [255, 149, 0], [255, 204, 0]],
	ocean: [[0, 24, 72], [0, 118, 255], [0, 217, 255]],
	neon: [[57, 255, 20], [0, 255, 255], [255, 0, 255]],
	forest: [[16, 64, 32], [34, 139, 34], [154, 205, 50]],
};

export function buildPresetPalette(name, colorCount) {
	if (name === 'grayscale') return makeGrayscalePalette(colorCount);
	if (name === 'realistic') return makeRealisticPalette(colorCount);
	const stops = gradientPresets[name] || gradientPresets.realistic;
	return makeGradientPalette(stops, colorCount);
}

/**
 * Core programmatic API to process a video to ASCII.
 * No terminal side-effects (no process.exit, no prompts, no stdout).
 *
 * @param {object} options
 * @param {object} callbacks
 */import { TerminalPlayer } from './terminal-player.js';

export { TerminalPlayer };

export async function generateBundle(options, callbacks = {}) {
	const {
		inputFile,
		outDir,
		width = 100,
		fps = 24,
		mode = 'truecolor',
		depth = 16,
		palette = 'realistic',
		customPalette = null,
		fg = '#00ff00',
		bg = '#000000',
		start = undefined,
		end = undefined,
		charMode = 'ascii',
		skipGif = false,
		crop = null,
		customTone = null,
		outlineOnly = false,
		detail = 100,
		qStep = 24,
		signal = undefined
	} = options;

	const noop = () => { };
	const onStart = callbacks.onStart || noop;
	const onProgress = callbacks.onProgress || noop;
	const onSuccess = callbacks.onSuccess || noop;
	const onFail = callbacks.onFail || noop;

	const inputPath = resolve(inputFile);

	try {
		await access(inputPath);
	} catch {
		throw new Error(`File not found: ${inputPath}`);
	}

	// Use outDir if provided, else root/output
	const defaultOutputDir = join(process.cwd(), 'output');
	const outputDir = resolve(outDir || defaultOutputDir);
	await mkdir(outputDir, { recursive: true });

	let meta;
	try {
		meta = await probeVideo(inputPath);
	} catch (err) {
		throw new Error(`Unable to probe video: ${err.message}`);
	}

	const inputExt = extname(inputPath).toLowerCase();

	let resolvedBg = '#000000';
	if (bg === 'auto') {
		onStart({ phase: 'background', message: 'Detecting optimal background colour…' });
		try {
			const bgStats = await sampleVideoLuminance(inputPath, width, meta);
			resolvedBg = bgStats.mean > 0.6 ? '#f0f0f0' : bgStats.mean > 0.4 ? '#1a1a2e' : '#0a0a0a';
			onSuccess({ phase: 'background', message: `Auto background: ${resolvedBg}` });
		} catch {
			onFail({ phase: 'background', message: 'Could not detect background, using #000000' });
			resolvedBg = '#000000';
		}
	} else if (bg) {
		resolvedBg = parseHexColor(bg, '#000000');
	}

	let render;
	let tone;

	if (mode === 'mono') {
		render = {
			mode: 'mono',
			palette: null,
			charMode,
			theme: { fg: fg || '#00ff00', bg: resolvedBg },
			label: 'Monochrome',
			_paletteName: undefined,
			_kmeansMode: false
		};
		tone = { contrast: 1.15, brightness: 0.02, saturation: 1.0, gamma: 1.05 };
	} else if (mode === 'palette') {
		let resolvedPalette;
		let label;
		if (customPalette && Array.isArray(customPalette)) {
			resolvedPalette = makeGradientPalette(customPalette, depth);
			label = `Custom palette (${depth} colors)`;
		} else {
			resolvedPalette = buildPresetPalette(palette, depth);
			label = `${palette} (${depth} colours)`;
		}

		onStart({ phase: 'tone', message: 'Sampling video for adaptive tone…' });
		try {
			const stats = await sampleVideoLuminance(inputPath, width, meta, crop);
			tone = adaptiveTone(depth, stats, inputExt, customTone);
			onSuccess({ phase: 'tone', message: `Adaptive tone: contrast=${tone.contrast.toFixed(2)} brightness=${tone.brightness.toFixed(3)} gamma=${tone.gamma.toFixed(2)} sat=${tone.saturation.toFixed(2)}` });
		} catch (err) {
			onFail({ phase: 'tone', message: `Tone sampling failed: ${err.message}`, error: err });
			tone = adaptiveTone(depth, null, inputExt, customTone);
		}

		render = {
			mode: 'palette',
			palette: resolvedPalette,
			charMode,
			theme: { fg: '#111111', bg: resolvedBg },
			label,
			_paletteName: customPalette ? undefined : palette,
			_kmeansMode: false
		};
	} else if (mode === 'kmeans') {
		onStart({ phase: 'palette', message: `Extracting optimal ${depth}-colour palette via k-means…` });
		const mlPalette = await extractPaletteFromVideo(inputPath, width, meta, depth, crop);
		if (!mlPalette) {
			onFail({ phase: 'palette', message: 'Could not sample video for k-means. Falling back to grayscale.' });
			render = {
				mode: 'palette',
				palette: makeGrayscalePalette(depth),
				charMode,
				theme: { fg: '#111111', bg: resolvedBg },
				label: `Grayscale fallback (${depth} colours)`,
				_paletteName: 'grayscale',
				_kmeansMode: false
			};
		} else {
			onSuccess({ phase: 'palette', message: `Extracted ${mlPalette.length} colours via k-means clustering` });
			render = {
				mode: 'palette',
				palette: mlPalette,
				charMode,
				theme: { fg: '#111111', bg: resolvedBg },
				label: `k-means optimal (${depth} colours)`,
				_paletteName: undefined,
				_kmeansMode: true
			};
		}

		try {
			const stats = await sampleVideoLuminance(inputPath, width, meta, crop);
			tone = adaptiveTone(depth, stats, inputExt, customTone);
		} catch {
			tone = adaptiveTone(depth, null, inputExt, customTone);
		}
	} else {
		// truecolor
		render = {
			mode: 'truecolor',
			palette: null,
			charMode,
			theme: { fg: '#111111', bg: resolvedBg },
			label: 'Truecolor (source)',
			_paletteName: undefined,
			_kmeansMode: false
		};
		tone = inputExt === '.gif'
			? { contrast: 1.35, brightness: 0.04, saturation: 1.2, gamma: 1.1 }
			: { contrast: 1.15, brightness: 0.02, saturation: 1.05, gamma: 1.05 };

		// Apply user brightness/contrast adjustments on top of base tone
		if (customTone) {
			if (typeof customTone.brightness === 'number') {
				tone.brightness += customTone.brightness / 100;
			}
			if (typeof customTone.contrast === 'number') {
				if (customTone.contrast < 0) {
					tone.contrast *= (100 + customTone.contrast) / 100;
				} else {
					tone.contrast += (customTone.contrast / 100) * 2;
				}
			}
		}
		tone.brightness = Math.max(-1.0, Math.min(1.0, tone.brightness));
		tone.contrast = Math.max(-2.0, Math.min(100.0, tone.contrast));
	}

	const outputJobDir = join(outputDir, safeOutputName(inputPath));
	await mkdir(outputJobDir, { recursive: true });

	const duration = typeof end === 'number'
		? Math.max(0, end - (start || 0))
		: meta.duration;
	const effectiveFps = fps || meta.fps || 24;
	const expectedFrames = duration && effectiveFps
		? Math.max(1, Math.round(duration * effectiveFps))
		: null;

	onStart({ phase: 'conversion', message: `Preparing conversion for ${basename(inputPath)}…`, expectedFrames });

	let frameCount = 0;
	const includeColors = render.mode !== 'mono';
	const gifPath = join(outputJobDir, 'preview.gif');
	let bundleWriter = null;
	let gifWriter = null;
	let frameHeight = null;
	let result;

	try {
		result = await convert({
			inputPath,
			outputWidth: width,
			color: includeColors,
			startTime: start,
			endTime: end,
			meta,
			targetFps: effectiveFps,
			tone,
			charMode: render.charMode || 'ascii',
			detail: typeof detail === 'number' ? detail : (outlineOnly ? 0 : 100),
			crop,
			collectFrames: false,
			signal,
			onFrame: (idx, frame) => {
				frameCount = idx + 1;
				onProgress({ phase: 'conversion', frameCount, expectedFrames });

				if (!bundleWriter) {
					frameHeight = Math.max(1, Math.round(frame.chars.length / width));
					bundleWriter = createBundleWriter({
						width, height: frameHeight, fps: effectiveFps,
						color: includeColors, outputDir: outputJobDir, render,
						qStep
					});
					if (!skipGif) {
						gifWriter = createAsciiGifWriter({
							width, height: frameHeight, fps: effectiveFps,
							render, outputPath: gifPath,
						});
					}
				}
				bundleWriter.writeFrame(frame);
				if (gifWriter) gifWriter.writeFrame(frame);
			},
		});
	} catch (err) {
		if (signal?.aborted) throw err;
		const error = new Error(`Conversion failed: ${err.message}`);
		onFail({ phase: 'conversion', message: error.message, error });
		throw error;
	}

	onSuccess({ phase: 'conversion', message: `Converted ${frameCount} frames (${result.width}×${result.height} @ ${effectiveFps.toFixed(1)} fps)`, result });

	if (gifWriter) {
		onStart({ phase: 'gif', message: 'Finalizing ASCII GIF preview…' });
		try {
			await gifWriter.finalize();
			onSuccess({ phase: 'gif', message: 'GIF preview generated!', gifPath });
		} catch (err) {
			onFail({ phase: 'gif', message: `GIF generation failed: ${err.message}`, error: err });
		}
	}

	onStart({ phase: 'bundle', message: 'Finalizing web bundle…' });
	let bundleInfo;
	try {
		bundleInfo = bundleWriter ? await bundleWriter.finalize() : null;
		onSuccess({ phase: 'bundle', message: 'Web bundle generated!', bundleInfo });
	} catch (err) {
		const error = new Error(`Bundle generation failed: ${err.message}`);
		onFail({ phase: 'bundle', message: error.message, error });
		throw error;
	}

	return {
		width: result.width,
		height: result.height,
		fps: effectiveFps,
		gifPath: gifWriter ? gifPath : null,
		bundlePath: bundleInfo?.bundlePath,
		htmlPath: bundleInfo?.htmlPath,
		stats: bundleInfo?.stats,
		render,
		frameCount
	};
}
