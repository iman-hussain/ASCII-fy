/**
 * ASCII-fi – ASCII GIF generator.
 *
 * Renders ASCII frames to a bitmap using a tiny 5x7 font and encodes
 * an animated GIF using gifenc (pure JS, no native deps).
 */

import gifenc from 'gifenc';
import { pickColorForChar, nearestPaletteColor, CHAR_RAMP, BLOCK_RAMP } from './render.js';

const isNode = typeof process !== 'undefined' && process.versions && process.versions.node;

const { GIFEncoder, quantize, applyPalette } = gifenc;

const FONT_W = 5;
const FONT_H = 7;
export const CELL_W = 6; // 5px glyph + 1px padding
export const CELL_H = 8; // 7px glyph + 1px padding


// ─── Density-based glyph generator ──────────────────────────────────────────
// Instead of hand-drawing 70+ bitmap glyphs, we generate a 5×7 fill pattern
// for each character based on its position in the luminance ramp.
// Darker chars (early ramp) have fewer lit pixels; brighter chars fill more.
// This makes the GIF look like real ASCII art with varying densities.

const _glyphCache = new Map();

// Hand-drawn 5×7 glyphs for edge/shape characters produced by the edge detector.
// These characters are NOT in CHAR_RAMP, so they need explicit definitions.
const EDGE_GLYPH_MAP = new Map([
	['_', ['     ', '     ', '     ', '     ', '     ', '     ', '#####']],
	['|', ['  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ', '  #  ']],
	['/', ['    #', '   ##', '   # ', '  #  ', ' #   ', '##   ', '#    ']],
	['\\', ['#    ', '##   ', ' #   ', '  #  ', '   # ', '   ##', '    #']],
	['J', [' ####', '    #', '    #', '    #', '    #', '#####', '     ']],
	['L', ['#    ', '#    ', '#    ', '#    ', '#    ', '#####', '     ']],
	['7', ['#####', '    #', '   # ', '   # ', '  #  ', '  #  ', '     ']],
	['r', ['     ', ' ####', '#    ', '#    ', '#    ', '#    ', '     ']],
]);

function getGlyph(ch) {
	if (_glyphCache.has(ch)) return _glyphCache.get(ch);

	let glyph;

	// 1. Check hand-drawn edge glyphs
	if (EDGE_GLYPH_MAP.has(ch)) {
		glyph = EDGE_GLYPH_MAP.get(ch);
		_glyphCache.set(ch, glyph);
		return glyph;
	}

	// 2. Block ramp chars (░▒▓█) — fill from bottom up proportionally
	const blockIdx = BLOCK_RAMP.indexOf(ch);
	if (blockIdx > 0) {
		const fillLevel = blockIdx / (BLOCK_RAMP.length - 1);
		const litCount = Math.round(fillLevel * FONT_W * FONT_H);
		const grid = Array.from({ length: FONT_H }, () => Array(FONT_W).fill(' '));
		let filled = 0;
		for (let gy = FONT_H - 1; gy >= 0 && filled < litCount; gy--) {
			for (let gx = 0; gx < FONT_W && filled < litCount; gx++) {
				grid[gy][gx] = '#';
				filled++;
			}
		}
		glyph = grid.map(row => row.join(''));
		_glyphCache.set(ch, glyph);
		return glyph;
	}

	// 3. CHAR_RAMP density-based fill (centre-outward)
	const idx = CHAR_RAMP.indexOf(ch);
	const level = idx <= 0 ? 0 : idx / (CHAR_RAMP.length - 1);

	// Number of pixels to light up out of 35 (5×7)
	const totalPixels = FONT_W * FONT_H;
	const litCount = Math.round(level * totalPixels);

	// Build a deterministic pattern: fill from center outward
	const grid = Array.from({ length: FONT_H }, () => Array(FONT_W).fill(' '));

	if (litCount > 0) {
		// Pre-compute distances from centre for each cell
		const cx = (FONT_W - 1) / 2;
		const cy = (FONT_H - 1) / 2;
		const cells = [];
		for (let y = 0; y < FONT_H; y++) {
			for (let x = 0; x < FONT_W; x++) {
				const dx = x - cx;
				const dy = y - cy;
				// Use a slight hash so the pattern isn't a perfect circle
				const hash = ((x * 7 + y * 13 + idx * 3) & 0xf) / 16;
				cells.push({ x, y, dist: dx * dx + dy * dy + hash });
			}
		}
		cells.sort((a, b) => a.dist - b.dist);

		for (let i = 0; i < Math.min(litCount, cells.length); i++) {
			grid[cells[i].y][cells[i].x] = '#';
		}
	}

	glyph = grid.map(row => row.join(''));
	_glyphCache.set(ch, glyph);
	return glyph;
}

function parseHexColor(hex, fallback) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
	if (!m) return fallback;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function renderFrameToRgba(frame, width, height, render) {
	const blockMode = render?.charMode === 'block';
	const imgW = width * CELL_W;
	const imgH = height * CELL_H;
	// Initialized to all-zero = fully transparent. Gap pixels (the 1px padding
	// column/row within each cell) remain alpha=0 (transparent) always.
	const pixels = new Uint8Array(imgW * imgH * 4);

	const bgSetting = render?.theme?.bg;
	const transparentBg = !bgSetting || bgSetting === 'transparent';
	const bg = transparentBg ? null : parseHexColor(bgSetting, null);
	const bgAlpha = bg ? 255 : 0;

	const defaultFg = parseHexColor(render?.theme?.fg, [0, 255, 0]);

	for (let y = 0; y < height; y++) {
		for (let x = 0; x < width; x++) {
			const i = y * width + x;
			const ch = frame.chars[i] || ' ';

			// Determine foreground colour for this cell
			let cellColor = null;
			if (ch !== ' ') {
				if (render?.mode === 'mono') {
					cellColor = defaultFg;
				} else if (frame.colors && frame.colors[i]) {
					cellColor = frame.colors[i];
					if (render?.mode === 'palette' && render?.palette?.length) {
						cellColor = nearestPaletteColor(cellColor, render.palette);
					}
				} else {
					cellColor = pickColorForChar(ch, render, null, defaultFg);
				}
			}

			// Only paint within the FONT_W × FONT_H glyph area (not the 1px gap).
			// Gap pixels stay alpha=0 (transparent) always.
			if (blockMode) {
				// Block mode: fill the FONT_W × FONT_H area with colour (or bg).
				const paint = cellColor || bg;
				const alpha = cellColor ? 255 : bgAlpha;
				if (!paint) continue; // fully transparent cell – nothing to write
				for (let gy = 0; gy < FONT_H; gy++) {
					for (let gx = 0; gx < FONT_W; gx++) {
						const px = x * CELL_W + gx;
						const py = y * CELL_H + gy;
						const o = (py * imgW + px) * 4;
						pixels[o] = paint[0]; pixels[o + 1] = paint[1]; pixels[o + 2] = paint[2]; pixels[o + 3] = alpha;
					}
				}
			} else {
				// Glyph mode: optionally fill glyph area with bg, then draw lit pixels.
				if (bg && bgAlpha > 0) {
					// Fill the FONT_W × FONT_H cell interior with the background.
					for (let gy = 0; gy < FONT_H; gy++) {
						for (let gx = 0; gx < FONT_W; gx++) {
							const px = x * CELL_W + gx;
							const py = y * CELL_H + gy;
							const o = (py * imgW + px) * 4;
							pixels[o] = bg[0]; pixels[o + 1] = bg[1]; pixels[o + 2] = bg[2]; pixels[o + 3] = 255;
						}
					}
				}
				// Draw lit glyph pixels (foreground) on top
				if (cellColor) {
					const glyph = getGlyph(ch);
					for (let gy = 0; gy < FONT_H; gy++) {
						const row = glyph[gy];
						for (let gx = 0; gx < FONT_W; gx++) {
							if (row[gx] !== '#') continue;
							const px = x * CELL_W + gx;
							const py = y * CELL_H + gy;
							const o = (py * imgW + px) * 4;
							pixels[o] = cellColor[0]; pixels[o + 1] = cellColor[1]; pixels[o + 2] = cellColor[2]; pixels[o + 3] = 255;
						}
					}
				}
			}
		}
	}

	return { pixels, imgW, imgH };
}

function getBackgroundColor(frame, render) {
	const themeBg = render?.theme?.bg;
	if (render?.mode === 'truecolor' && (themeBg === 'auto' || themeBg === 'transparent') && frame.colors) {
		let r = 0; let g = 0; let b = 0;
		const total = frame.colors.length || 1;
		for (let i = 0; i < total; i++) {
			const c = frame.colors[i];
			r += c[0]; g += c[1]; b += c[2];
		}
		return [Math.round(r / total), Math.round(g / total), Math.round(b / total)];
	}
	return parseHexColor(themeBg, null);
}

/**
 * Generate an ASCII GIF preview from converted frames.
 *
 * @param {object} opts
 * @param {number} opts.width
 * @param {number} opts.height
 * @param {number} opts.fps
 * @param {object} opts.render
 * @param {string} opts.outputPath
 */
export function createAsciiGifWriter({ width, height, fps, render, outputPath }) {
	const encoder = GIFEncoder();
	const delay = Math.max(20, Math.round(1000 / (fps || 12)));
	const framesParams = [];

	const writeFrame = (frame) => {
		framesParams.push(frame);
	};

	const finalize = async () => {
		// Render all frames memory buffers
		const renderedFrames = framesParams.map(f => renderFrameToRgba(f, width, height, render));
		if (renderedFrames.length === 0) return;

		const imgW = renderedFrames[0].imgW;
		const imgH = renderedFrames[0].imgH;

		// Sample pixels across frames to generate a single global palette
		const maxSampleFrames = 25;
		const step = Math.max(1, Math.floor(renderedFrames.length / maxSampleFrames));

		let samplePixelsLength = 0;
		for (let i = 0; i < renderedFrames.length; i += step) {
			samplePixelsLength += renderedFrames[i].pixels.length;
		}

		const sampleBuffer = new Uint8Array(samplePixelsLength);
		let offset = 0;
		for (let i = 0; i < renderedFrames.length; i += step) {
			sampleBuffer.set(renderedFrames[i].pixels, offset);
			offset += renderedFrames[i].pixels.length;
		}

		// Quantize to 255 colours, reserving the last index for transparency
		const basePalette = quantize(sampleBuffer, 255);
		const palette = [...basePalette, [255, 0, 255]]; // Magenta transparent key
		const TRANSPARENT_INDEX = palette.length - 1;

		const hasTransparentBg = render?.theme?.bg === 'transparent';
		let prevIndexBuffer = null;

		for (let i = 0; i < renderedFrames.length; i++) {
			const { pixels } = renderedFrames[i];
			const index = applyPalette(pixels, basePalette);

			// Always map alpha=0 pixels (gap pixels + transparent bg) to TRANSPARENT_INDEX.
			// This is necessary regardless of bg mode — gap pixels are always alpha=0
			// from renderFrameToRgba, and we must not let them get quantized to a
			// dark palette entry (which would render as opaque black/white).
			for (let j = 0; j < index.length; j++) {
				if (pixels[j * 4 + 3] === 0) {
					index[j] = TRANSPARENT_INDEX;
				}
			}

			if (!hasTransparentBg && prevIndexBuffer) {
				// Opaque mode: inter-frame LZW deduplication — mark unchanged
				// pixels (that are still opaque) as transparent for compression.
				for (let j = 0; j < index.length; j++) {
					if (index[j] === TRANSPARENT_INDEX) continue; // already transparent
					if (index[j] === prevIndexBuffer[j]) {
						index[j] = TRANSPARENT_INDEX;
					} else {
						prevIndexBuffer[j] = index[j];
					}
				}
			}

			if (!hasTransparentBg && !prevIndexBuffer) {
				prevIndexBuffer = new Uint8Array(index);
			}

			encoder.writeFrame(index, imgW, imgH, {
				palette: (i === 0) ? palette : undefined,
				transparent: true,
				transparentIndex: TRANSPARENT_INDEX,
				delay,
				dispose: hasTransparentBg ? 2 : 1
			});
		}

		encoder.finish();
		const gifData = encoder.bytes();
		if (outputPath && isNode) {
			const { writeFile } = await import('node:fs/promises');
			await writeFile(outputPath, gifData);
		}

		return {
			buffer: gifData,
			width: imgW,
			height: imgH
		};
	};

	return { writeFrame, finalize };
}
