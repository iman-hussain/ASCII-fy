/**
 * ascii-fy – Adaptive tone mapping for limited colour palettes.
 *
 * When quantising to 4/16/32/64 colours the original image can become
 * muddy or invisible.  This module analyses a sample of source pixel
 * data and returns FFmpeg `eq` filter values that stretch contrast,
 * lift shadows and boost saturation so the final palette-mapped result
 * still reads as the original scene.
 *
 * The approach is a lightweight "perceptual" model, not a neural net,
 * but it is data-driven:
 *   1. Sample luminance histogram from the first frame(s).
 *   2. Compute dynamic range, mean brightness, shadow/highlight ratios.
 *   3. Map those stats to contrast/brightness/gamma/saturation curves
 *      that are tuned per colour-depth tier.
 */

/**
 * Compute luminance stats from raw RGB24 pixel buffer.
 * @param {Uint8Array} pixels – raw RGB24 data
 * @param {number} [sampleStep=4] – stride to speed up sampling
 */
export function analyseLuminance(pixels, sampleStep = 4) {
	const hist = new Uint32Array(256);
	let count = 0;
	let sum = 0;

	for (let i = 0; i < pixels.length; i += 3 * sampleStep) {
		const r = pixels[i];
		const g = pixels[i + 1];
		const b = pixels[i + 2];
		const lum = Math.round(0.2126 * r + 0.7152 * g + 0.0722 * b);
		hist[lum]++;
		sum += lum;
		count++;
	}

	if (count === 0) return { mean: 128, low: 0, high: 255, range: 255, shadowRatio: 0.5 };

	const mean = sum / count;

	// 5th / 95th percentile
	const p05 = percentile(hist, count, 0.05);
	const p95 = percentile(hist, count, 0.95);
	const range = Math.max(1, p95 - p05);

	let shadowCount = 0;
	for (let i = 0; i <= 64; i++) shadowCount += hist[i];
	const shadowRatio = shadowCount / count;

	return { mean, low: p05, high: p95, range, shadowRatio };
}

function percentile(hist, total, p) {
	const target = Math.floor(total * p);
	let acc = 0;
	for (let i = 0; i < 256; i++) {
		acc += hist[i];
		if (acc >= target) return i;
	}
	return 255;
}

/**
 * Derive FFmpeg `eq` filter parameters that maximise perceptual
 * clarity for a given colour depth.
 *
 * @param {number} colorDepth – palette size: 4, 16, 32, 64, 256+
 * @param {object} [stats]    – output of analyseLuminance(); if null
 *                               we fall back to reasonable defaults.
 * @param {string} [fileExt]  – e.g. '.gif', '.mp4'
 * @param {object} [customTone] - User defined override offsets (-100 to 100)
 * @returns {{ contrast: number, brightness: number, saturation: number, gamma: number }}
 */
export function adaptiveTone(colorDepth, stats, fileExt, customTone) {
	// Base boost factors per depth tier – fewer colours → more aggressive
	const tier = depthTier(colorDepth);

	// Start from neutral
	let contrast = 1.0;
	let brightness = 0.0;
	let saturation = 1.0;
	let gamma = 1.0;

	// --- Contrast: stretch dynamic range into the palette ---
	// Ideal range for quantisation is ~200 levels; if the source is
	// compressed into a small band, push contrast proportionally.
	const idealRange = 200;
	if (stats) {
		const rangeDeficit = Math.max(0, idealRange - stats.range) / idealRange;
		contrast = 1.0 + rangeDeficit * tier.contrastCeiling;
	} else {
		contrast = tier.contrastDefault;
	}

	// --- Brightness: lift shadows so dark detail survives quantisation ---
	if (stats) {
		// If the image is dark (mean < 90), lift it
		if (stats.mean < 90) {
			brightness = Math.min(tier.brightnessCeiling, (90 - stats.mean) / 255 * tier.brightnessMult);
		}
		// If shadow-heavy, additional lift
		if (stats.shadowRatio > 0.4) {
			brightness += Math.min(0.05, (stats.shadowRatio - 0.4) * 0.15);
		}
	} else {
		brightness = tier.brightnessDefault;
	}

	// --- Gamma: open up mid-tones for low-palette modes ---
	if (stats) {
		// If midtones are crushed (mean well below 128) boost gamma
		if (stats.mean < 100) {
			gamma = 1.0 + (100 - stats.mean) / 200 * tier.gammaCeiling;
		}
	} else {
		gamma = tier.gammaDefault;
	}

	// --- Saturation: punch up colour so palette mapping keeps vibrancy ---
	saturation = tier.saturationDefault;

	// GIFs tend to already be contrasty, don't over-boost
	if (fileExt === '.gif') {
		contrast = Math.min(contrast, contrast * 0.85);
		brightness = Math.min(brightness, 0.06);
	}

	// Override with Custom User Controls
	if (customTone) {
		if (typeof customTone.brightness === 'number') {
			brightness += (customTone.brightness / 100);
		}
		if (typeof customTone.contrast === 'number') {
			// Scale contrast exponentially for intuitive slider feel (-100 = 0x, +100 = ~3.0x)
			if (customTone.contrast < 0) {
				contrast *= (100 + customTone.contrast) / 100;
			} else {
				contrast += (customTone.contrast / 100) * 2;
			}
		}
	}

	// Rigid clamps for FFmpeg eq filters to prevent engine overflow/blackout
	contrast = Math.max(-2.0, Math.min(100.0, contrast));
	brightness = Math.max(-1.0, Math.min(1.0, brightness));
	saturation = Math.max(0.0, Math.min(3.0, saturation));
	gamma = Math.max(0.1, Math.min(10.0, gamma));

	return { contrast, brightness, saturation, gamma };
}

function depthTier(depth) {
	if (depth <= 4) return { contrastCeiling: 0.6, contrastDefault: 1.25, brightnessCeiling: 0.05, brightnessMult: 0.8, brightnessDefault: 0.03, gammaCeiling: 0.3, gammaDefault: 1.15, saturationDefault: 1.3 };
	if (depth <= 16) return { contrastCeiling: 0.4, contrastDefault: 1.15, brightnessCeiling: 0.04, brightnessMult: 0.6, brightnessDefault: 0.02, gammaCeiling: 0.2, gammaDefault: 1.05, saturationDefault: 1.15 };
	if (depth <= 32) return { contrastCeiling: 0.25, contrastDefault: 1.1, brightnessCeiling: 0.03, brightnessMult: 0.4, brightnessDefault: 0.01, gammaCeiling: 0.1, gammaDefault: 1.02, saturationDefault: 1.05 };
	if (depth <= 64) return { contrastCeiling: 0.15, contrastDefault: 1.05, brightnessCeiling: 0.02, brightnessMult: 0.3, brightnessDefault: 0.01, gammaCeiling: 0.05, gammaDefault: 1.0, saturationDefault: 1.0 };
	// 256+ / truecolor – minimal adjustment
	return { contrastCeiling: 0.1, contrastDefault: 1.0, brightnessCeiling: 0.01, brightnessMult: 0.1, brightnessDefault: 0.0, gammaCeiling: 0.0, gammaDefault: 1.0, saturationDefault: 1.0 };
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * Sample the first N bytes of a video via FFmpeg and return luminance stats.
 * This is used before the main conversion so we can set tone parameters.
 *
 * @param {string} inputPath
 * @param {number} outputWidth
 * @param {object} meta – { width, height }
 * @returns {Promise<object>} stats from analyseLuminance
 */
export async function sampleVideoLuminance(inputPath, outputWidth, meta, crop) {
	const { spawn } = await import('node:child_process');
	const ffmpegPath = (await import('ffmpeg-static')).default;

	const validCrop = crop && crop.w && crop.h;
	const srcW = validCrop ? crop.w : meta.width;
	const srcH = validCrop ? crop.h : meta.height;

	const scaledH = Math.max(1, Math.round((outputWidth / srcW) * srcH / 2));

	const filters = [];
	if (validCrop) {
		filters.push(`crop=${crop.w}:${crop.h}:${crop.x || 0}:${crop.y || 0}`);
	}
	filters.push(`scale=${outputWidth}:${scaledH}:flags=fast_bilinear`);

	const args = [
		'-ss', '0',
		'-i', inputPath,
		'-frames:v', '1',
		'-f', 'image2pipe',
		'-vcodec', 'rawvideo',
		'-pix_fmt', 'rgb24',
		'-vf', filters.join(','),
		'-',
	];

	return new Promise((resolve) => {
		const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		proc.stdout.on('data', (c) => chunks.push(c));
		proc.on('close', () => {
			const buf = Buffer.concat(chunks);
			if (buf.length < 3) return resolve(null);
			resolve(analyseLuminance(new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)));
		});
		proc.on('error', () => resolve(null));
	});
}
