/**
 * ASCII-fi – Shared core rendering engine.
 *
 * Decoupled from Node.js ChildProcess and FileSystem, this class
 * accepts raw Uint8Array (RGB24) frame data and outputs ASCII/Colour
 * results. It maintains internal state for frame-to-frame stabilization
 * and background isolation.
 */

import { CHAR_RAMP, BLOCK_RAMP } from './render.js';

const EDGE_THRESHOLD = 30; // min quadrant lum range to count as an edge
const COLOR_STABLE_THRESHOLD = 18 * 18 * 3; // ~18 per channel

// 4-bit edge classification lookup table
const EDGE_TABLE = [
	' ',    // 0000  (handled separately)
	'.',    // 0001  BR bright
	'.',    // 0010  BL bright
	'_',    // 0011  bottom bright
	'.',    // 0100  TR bright
	'|',    // 0101  right column
	'/',    // 0110  anti-diagonal
	'J',    // 0111  TL dark corner
	'.',    // 1000  TL bright
	'\\',   // 1001  main diagonal
	'|',    // 1010  left column
	'L',    // 1011  TR dark corner
	'-',    // 1100  top bright
	'7',    // 1101  BL dark corner
	'r',    // 1110  BR dark corner
	'#',    // 1111  all bright  (handled separately)
];

export class AsciiEngine {
	constructor() {
		this.reset();
	}

	reset() {
		this.prevFrameColors = null;
		this.prevFrameChars = null;
		this.bgModelColors = null;
		this.frozenChars = null;
		this.frozenColors = null;
		this.frameCounter = 0;
	}

	/**
	 * Process a single raw RGB24 frame into ASCII data.
	 *
	 * @param {Uint8Array} pixels - Raw RGB24 bytes (length = scaledW * scaledH * 3)
	 * @param {number} scaledW - Actual pixel width of input buffer
	 * @param {number} scaledH - Actual pixel height of input buffer
	 * @param {number} outW - Output width (characters)
	 * @param {number} outH - Output height (characters)
	 * @param {number} sampleFactor - Scaling factor (e.g. 4 for edge detection)
	 * @param {boolean} useColor - Whether to compute per-cell color data
	 * @param {string} charMode - 'ascii' or 'block'
	 * @param {object} foreground - Isolation settings
	 * @param {boolean[]} fgMask - Optional per-cell mask from ML model
	 * @param {number} detail - Edge/Fill visibility (0-100)
	 */
	processFrame(pixels, scaledW, scaledH, outW, outH, sampleFactor, useColor, charMode, foreground, fgMask, detail = 100) {
		const totalChars = outW * outH;
		const charsArr = new Array(totalChars);
		let colors = useColor ? new Array(totalChars) : null;

		this.frameCounter++;

		const useForeground = foreground && (foreground.mode === 'motion' || foreground.mode === 'ml');
		const bgMode = foreground?.background || 'solid';   // 'transparent' | 'solid' | 'keep'
		const motionThreshold = typeof foreground?.threshold === 'number' ? foreground.threshold : 20;
		const motionThresholdSq = motionThreshold * motionThreshold * 3;
		const bgRgb = (bgMode === 'solid')
			? this.parseHexColor(foreground?.bg, [0, 0, 0])
			: [0, 0, 0];

		const blockW = sampleFactor;
		const blockH = sampleFactor;
		const denom = blockW * blockH;
		const halfW = blockW >> 1;
		const halfH = blockH >> 1;
		const qDenom = halfW * halfH;
		const isBlockMode = charMode === 'block';

		// ── Pass 1: compute raw char + colour for every cell ──
		const rawChars = new Array(totalChars);
		const rawColors = useColor ? new Array(totalChars) : null;

		for (let y = 0; y < outH; y++) {
			for (let x = 0; x < outW; x++) {
				let rSum = 0, gSum = 0, bSum = 0;
				let qTL = 0, qTR = 0, qBL = 0, qBR = 0;
				const startX = x * blockW;
				const startY = y * blockH;

				for (let by = 0; by < blockH; by++) {
					const row = (startY + by) * scaledW;
					for (let bx = 0; bx < blockW; bx++) {
						const idx = (row + startX + bx) * 3;
						const pr = pixels[idx];
						const pg = pixels[idx + 1];
						const pb = pixels[idx + 2];
						rSum += pr; gSum += pg; bSum += pb;
						if (!isBlockMode) {
							const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
							if (by < halfH) {
								if (bx < halfW) qTL += lum; else qTR += lum;
							} else {
								if (bx < halfW) qBL += lum; else qBR += lum;
							}
						}
					}
				}

				const r = rSum / denom, g = gSum / denom, b = bSum / denom;
				const i = y * outW + x;

				let ch;
				if (isBlockMode) {
					const yLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
					const fillThreshold = detail < 100 ? 255 * (1 - detail / 100) : 0;
					if (yLum < fillThreshold) {
						ch = ' ';
					} else {
						const ci = Math.min(BLOCK_RAMP.length - 1, Math.floor((yLum / 255) * BLOCK_RAMP.length));
						ch = BLOCK_RAMP[ci];
					}
				} else {
					ch = this.selectEdgeChar(qTL / qDenom, qTR / qDenom, qBL / qDenom, qBR / qDenom, detail);
				}

				rawChars[i] = ch;
				if (rawColors) rawColors[i] = [Math.round(r), Math.round(g), Math.round(b)];
			}
		}

		// ── Snapshot first frame for 'keep' background ──
		if (useForeground && bgMode === 'keep' && this.frameCounter === 1) {
			this.frozenChars = rawChars.slice();
			this.frozenColors = rawColors ? rawColors.slice() : null;
		}

		// ── Compute foreground mask ──
		const fgFlags = useForeground ? new Uint8Array(totalChars) : null;
		if (useForeground) {
			if (foreground.mode === 'motion') {
				if (!this.bgModelColors) {
					this.bgModelColors = new Array(totalChars);
					for (let i = 0; i < totalChars; i++) {
						this.bgModelColors[i] = rawColors
							? [rawColors[i][0], rawColors[i][1], rawColors[i][2]]
							: [128, 128, 128];
						fgFlags[i] = 1;
					}
				} else {
					for (let i = 0; i < totalChars; i++) {
						const cr = rawColors ? rawColors[i][0] : 128;
						const cg = rawColors ? rawColors[i][1] : 128;
						const cb = rawColors ? rawColors[i][2] : 128;
						const bgc = this.bgModelColors[i];
						const dr = cr - bgc[0], dg = cg - bgc[1], db = cb - bgc[2];
						const dist = dr * dr + dg * dg + db * db;

						if (dist >= motionThresholdSq) {
							fgFlags[i] = 1;
						} else {
							fgFlags[i] = 0;
							const a = 0.05; // adaptation rate
							bgc[0] = Math.round(bgc[0] * (1 - a) + cr * a);
							bgc[1] = Math.round(bgc[1] * (1 - a) + cg * a);
							bgc[2] = Math.round(bgc[2] * (1 - a) + cb * a);
						}
					}
				}
			} else if (foreground.mode === 'ml' && fgMask) {
				for (let i = 0; i < totalChars; i++) fgFlags[i] = fgMask[i] ? 1 : 0;
			}
		}

		// ── Pass 2: assemble output with stabilization ──
		for (let i = 0; i < totalChars; i++) {
			const isFg = !useForeground || (fgFlags && fgFlags[i]);

			if (useForeground && !isFg) {
				if (bgMode === 'keep') {
					charsArr[i] = (this.frozenChars && this.frozenChars[i]) || ' ';
					if (useColor) colors[i] = (this.frozenColors && this.frozenColors[i]) || bgRgb;
				} else {
					charsArr[i] = ' ';
					if (useColor) colors[i] = bgRgb;
				}
				continue;
			}

			const ch = rawChars[i];
			if (useColor) {
				colors[i] = (ch === ' ') ? bgRgb : rawColors[i];
			}

			// Colour stabilisation
			if (this.prevFrameColors && this.prevFrameChars && this.prevFrameColors[i] && this.prevFrameChars[i] !== ' ') {
				const pc = this.prevFrameColors[i];
				const cr = rawColors ? rawColors[i][0] : 0;
				const cg = rawColors ? rawColors[i][1] : 0;
				const cb = rawColors ? rawColors[i][2] : 0;
				const dr2 = cr - pc[0], dg2 = cg - pc[1], db2 = cb - pc[2];
				if (dr2 * dr2 + dg2 * dg2 + db2 * db2 < COLOR_STABLE_THRESHOLD) {
					charsArr[i] = this.prevFrameChars[i];
					continue;
				}
			}
			charsArr[i] = ch;
		}

		const chars = charsArr.join('');
		this.prevFrameColors = rawColors ? rawColors.slice() : null;
		this.prevFrameChars = charsArr.slice();

		return useColor ? { chars, colors } : { chars };
	}

	selectEdgeChar(tl, tr, bl, br, detail = 100) {
		const avg = (tl + tr + bl + br) / 4;
		if (avg < 8) return ' ';

		const range = Math.max(tl, tr, bl, br) - Math.min(tl, tr, bl, br);
		const fillThreshold = detail < 100 ? 255 * (1 - detail / 100) : 0;

		if (range < EDGE_THRESHOLD) {
			if (avg < fillThreshold) return ' ';
			const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
			return CHAR_RAMP[idx];
		}

		const pattern = ((tl > avg ? 1 : 0) << 3) |
			((tr > avg ? 1 : 0) << 2) |
			((bl > avg ? 1 : 0) << 1) |
			(br > avg ? 1 : 0);

		if (pattern === 0 || pattern === 15) {
			if (avg < fillThreshold) return ' ';
			const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
			return CHAR_RAMP[idx];
		}

		return EDGE_TABLE[pattern];
	}

	parseHexColor(hex, fallback) {
		const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
		if (!m) return fallback;
		const n = parseInt(m[1], 16);
		return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
	}
}
