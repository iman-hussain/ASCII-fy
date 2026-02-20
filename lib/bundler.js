/**
 * ascii-fy – Bundle generator.
 *
 * Takes the converted frame data, applies:
 *   1. Run-Length Encoding (RLE) for characters
 *   2. Colour dictionary – unique colours indexed, per-char stores index
 *   3. Delta encoding – only changed cells between frames are stored
 *   4. Gzip compression via pako for the final JSON payload
 *
 * Writes a self-contained `bundle.js` + `demo.html` to the output directory.
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';
import PLAYER_SOURCE from './player.js';
import { nearestPaletteColor } from './render.js';

// Lossy delta threshold – skip colour changes below this Euclidean²
// distance between frames.  Reduces delta entries for noisy video.
const COLOUR_DELTA_THRESHOLD = 48;   // ~7 per channel

// ────────────────────────────────────────────────────────────────────────────
// Encoding helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Run-Length Encode a character string.
 * "AAABBC" → [3, "A", 2, "B", 1, "C"]
 */
function rleEncodeChars(str) {
	if (!str.length) return [];
	const rle = [];
	let current = str[0];
	let count = 1;

	for (let i = 1; i < str.length; i++) {
		if (str[i] === current) {
			count++;
		} else {
			rle.push(count, current);
			current = str[i];
			count = 1;
		}
	}
	rle.push(count, current);
	return rle;
}

/**
 * Quantise a single channel value to reduce unique colours.
 */
function quantizeChannel(v, step) {
	return Math.round(v / step) * step;
}

/**
 * RLE-encode a flat colour array, optionally snapping to a palette.
 */
function rleEncodeColors(colors, qStep = 4, palette = null) {
	if (!colors || !colors.length) return [];
	const rle = [];

	function snap(c) {
		if (palette && palette.length) {
			return nearestPaletteColor(c, palette);
		}
		return [
			quantizeChannel(c[0], qStep),
			quantizeChannel(c[1], qStep),
			quantizeChannel(c[2], qStep),
		];
	}

	let current = snap(colors[0]);
	let count = 1;

	for (let i = 1; i < colors.length; i++) {
		const q = snap(colors[i]);
		if (q[0] === current[0] && q[1] === current[1] && q[2] === current[2]) {
			count++;
		} else {
			rle.push(count, current);
			current = q;
			count = 1;
		}
	}
	rle.push(count, current);
	return rle;
}

// ────────────────────────────────────────────────────────────────────────────
// Colour dictionary – maps unique [r,g,b] → compact index
// ────────────────────────────────────────────────────────────────────────────

function buildColorDict(frames, qStep, palette) {
	const map = new Map();
	const dict = [];

	function key(c) { return `${c[0]},${c[1]},${c[2]}`; }

	function snap(c) {
		if (palette && palette.length) return nearestPaletteColor(c, palette);
		return [
			quantizeChannel(c[0], qStep),
			quantizeChannel(c[1], qStep),
			quantizeChannel(c[2], qStep),
		];
	}

	for (const frame of frames) {
		if (!frame.colors) continue;
		for (const c of frame.colors) {
			const s = snap(c);
			const k = key(s);
			if (!map.has(k)) {
				map.set(k, dict.length);
				dict.push(s);
			}
		}
	}

	return { dict, map, snap, key };
}

/**
 * Convert per-pixel [r,g,b] colours to dictionary-index array,
 * then RLE-encode the indices (single int runs much better under RLE).
 */
function rleEncodeColorIndices(colors, dictInfo) {
	if (!colors || !colors.length) return [];
	const { snap, key, map } = dictInfo;
	const rle = [];
	let prev = map.get(key(snap(colors[0])));
	let count = 1;

	for (let i = 1; i < colors.length; i++) {
		const idx = map.get(key(snap(colors[i])));
		if (idx === prev) {
			count++;
		} else {
			rle.push(count, prev);
			prev = idx;
			count = 1;
		}
	}
	rle.push(count, prev);
	return rle;
}

// ────────────────────────────────────────────────────────────────────────────
// Delta encoding – only store cells that changed between frames
// ────────────────────────────────────────────────────────────────────────────

/**
 * Check if two colour-dictionary indices represent visually-similar colours.
 * Used for lossy delta: skip tiny colour changes to reduce output size.
 */
function colorIndicesClose(idxA, idxB, dict) {
	if (idxA === idxB) return true;
	if (!dict) return false;
	const a = dict[idxA], b = dict[idxB];
	if (!a || !b) return false;
	const dr = a[0] - b[0], dg = a[1] - b[1], db = a[2] - b[2];
	return (dr * dr + dg * dg + db * db) < COLOUR_DELTA_THRESHOLD;
}

function deltaEncodeFrames(frames, color, dictInfo) {
	const encoded = [];
	let prevChars = null;
	let prevColorIndices = null;
	const dict = dictInfo?.dict || null;

	for (const frame of frames) {
		const curChars = frame.chars;

		// Build current colour index array
		let curColorIndices = null;
		if (color && frame.colors && dictInfo) {
			const { snap, key, map } = dictInfo;
			curColorIndices = frame.colors.map((c) => map.get(key(snap(c))));
		}

		if (prevChars === null) {
			// First frame: full data
			const enc = { chars: rleEncodeChars(curChars) };
			if (color && curColorIndices) {
				enc.ci = rleEncodeFromArray(curColorIndices);
			}
			encoded.push(enc);
		} else {
			// Delta: only changed positions
			const charDiffs = [];
			const colorDiffs = [];
			let hasDiff = false;

			for (let i = 0; i < curChars.length; i++) {
				const charChanged = curChars[i] !== prevChars[i];
				// Lossy: treat small colour changes as identical
				const colorChanged = color && curColorIndices && prevColorIndices &&
					!colorIndicesClose(curColorIndices[i], prevColorIndices[i], dict);

				if (charChanged || colorChanged) {
					charDiffs.push(i, curChars[i]);
					if (color && curColorIndices) {
						colorDiffs.push(i, curColorIndices[i]);
					}
					hasDiff = true;
				}
			}

			if (!hasDiff) {
				encoded.push({ d: 1 });
			} else {
				const ratio = charDiffs.length / 2 / curChars.length;
				if (ratio > 0.7) {
					const enc = { chars: rleEncodeChars(curChars) };
					if (color && curColorIndices) {
						enc.ci = rleEncodeFromArray(curColorIndices);
					}
					encoded.push(enc);
				} else {
					const enc = { cd: charDiffs };
					if (color && colorDiffs.length) {
						enc.cid = colorDiffs;
					}
					encoded.push(enc);
				}
			}
		}

		prevChars = curChars;
		prevColorIndices = curColorIndices;
	}

	return encoded;
}

/**
 * RLE for a flat integer array: [v,v,v,w,w] → [3,v,2,w]
 */
function rleEncodeFromArray(arr) {
	if (!arr.length) return [];
	const rle = [];
	let prev = arr[0];
	let count = 1;
	for (let i = 1; i < arr.length; i++) {
		if (arr[i] === prev) { count++; }
		else { rle.push(count, prev); prev = arr[i]; count = 1; }
	}
	rle.push(count, prev);
	return rle;
}

// ────────────────────────────────────────────────────────────────────────────
// V5 compact binary encoding helpers
// ────────────────────────────────────────────────────────────────────────────

class BinaryWriter {
	constructor() {
		this.chunks = [];
	}
	writeUint8(v) {
		this.chunks.push(Buffer.from([v]));
	}
	writeUint16(v) {
		const b = Buffer.allocUnsafe(2);
		b.writeUInt16LE(v, 0);
		this.chunks.push(b);
	}
	writeVarInt(v) {
		let bytes = [];
		while (v >= 0x80) {
			bytes.push((v & 0x7f) | 0x80);
			v >>>= 7;
		}
		bytes.push(v);
		this.chunks.push(Buffer.from(bytes));
	}
	writeString(str) {
		const buf = Buffer.from(str, 'utf-8');
		this.writeVarInt(buf.length);
		this.chunks.push(buf);
	}
	toBuffer() {
		return Buffer.concat(this.chunks);
	}
}

function encodeGaps(positions) {
	const gaps = new Array(positions.length);
	let prev = 0;
	for (let i = 0; i < positions.length; i++) {
		gaps[i] = positions[i] - prev;
		prev = positions[i];
	}
	return gaps;
}

function rleEncodeCharsBinary(str) {
	if (!str.length) return { counts: [], chars: '' };
	const counts = [];
	let chars = '';
	let current = str[0];
	let count = 1;
	for (let i = 1; i < str.length; i++) {
		if (str[i] === current) { count++; }
		else { counts.push(count); chars += current; current = str[i]; count = 1; }
	}
	counts.push(count);
	chars += current;
	return { counts, chars };
}

function rleEncodeFromArrayBinary(arr) {
	if (!arr.length) return [];
	const rle = [];
	let prev = arr[0], count = 1;
	for (let i = 1; i < arr.length; i++) {
		if (arr[i] === prev) { count++; }
		else { rle.push(count, prev); prev = arr[i]; count = 1; }
	}
	rle.push(count, prev);
	return rle;
}

/**
 * V5 delta encoding – fully structured binary ready formats:
 *  - Full frames:  { type: 1, charCounts, chars, colorRLE? }
 *  - Delta frames: { type: 2, charGaps, chars, colorGaps?, colorVals? }
 *  - Duplicate:    { type: 0 }
 */
function deltaEncodeFramesBinary(frames, color, dictInfo) {
	const encoded = [];
	let prevChars = null;
	let prevColorIndices = null;
	const dict = dictInfo?.dict || null;

	for (const frame of frames) {
		const curChars = frame.chars;

		let curColorIndices = null;
		if (color && frame.colors && dictInfo) {
			const { snap, key, map } = dictInfo;
			curColorIndices = frame.colors.map((c) => map.get(key(snap(c))));
		}

		if (prevChars === null) {
			// First frame – full data
			const rle = rleEncodeCharsBinary(curChars);
			const enc = { type: 1, charCounts: rle.counts, chars: rle.chars };
			if (color && curColorIndices) {
				enc.colorRLE = rleEncodeFromArrayBinary(curColorIndices);
			}
			encoded.push(enc);
		} else {
			// Delta – collect changed positions
			const charPositions = [];
			let charValues = '';
			const colorPositions = [];
			const colorValues = [];
			let hasDiff = false;

			for (let i = 0; i < curChars.length; i++) {
				const charChanged = curChars[i] !== prevChars[i];
				const colorChanged = color && curColorIndices && prevColorIndices &&
					!colorIndicesClose(curColorIndices[i], prevColorIndices[i], dict);

				if (charChanged || colorChanged) {
					charPositions.push(i);
					charValues += curChars[i];
					if (color && curColorIndices) {
						colorPositions.push(i);
						colorValues.push(curColorIndices[i]);
					}
					hasDiff = true;
				}
			}

			if (!hasDiff) {
				encoded.push({ type: 0 });
			} else {
				const ratio = charPositions.length / curChars.length;
				if (ratio > 0.7) {
					// Too many changes – store full frame
					const rle = rleEncodeCharsBinary(curChars);
					const enc = { type: 1, charCounts: rle.counts, chars: rle.chars };
					if (color && curColorIndices) {
						enc.colorRLE = rleEncodeFromArrayBinary(curColorIndices);
					}
					encoded.push(enc);
				} else {
					// Sparse delta with gap-encoded positions
					const enc = { type: 2, charGaps: encodeGaps(charPositions), chars: charValues };
					if (color && colorPositions.length) {
						enc.colorGaps = encodeGaps(colorPositions);
						enc.colorVals = colorValues;
					}
					encoded.push(enc);
				}
			}
		}

		prevChars = curChars;
		prevColorIndices = curColorIndices;
	}

	return encoded;
}

function buildBinaryPayload(width, height, fps, color, renderConfig, dictArray, encodedFrames) {
	const writer = new BinaryWriter();

	// Header
	writer.writeString("ASCIFY");
	writer.writeUint8(5); // V5
	writer.writeUint16(width);
	writer.writeUint16(height);
	writer.writeUint8(Math.round(fps));
	writer.writeUint8(color ? 1 : 0);

	// Render Config
	writer.writeString(renderConfig.mode || 'truecolor');
	writer.writeString(renderConfig.theme?.fg || '#0f0');
	writer.writeString(renderConfig.theme?.bg || '#000');

	// Color Dictionary
	if (color && dictArray && dictArray.length > 0) {
		writer.writeVarInt(dictArray.length);
		for (const c of dictArray) {
			writer.writeUint8(c[0]);
			writer.writeUint8(c[1]);
			writer.writeUint8(c[2]);
		}
	} else {
		writer.writeVarInt(0);
	}

	// Frames
	writer.writeVarInt(encodedFrames.length);
	for (const f of encodedFrames) {
		writer.writeUint8(f.type);
		if (f.type === 0) continue; // Duplicate

		if (f.type === 1) { // Full
			writer.writeVarInt(f.charCounts.length);
			for (const c of f.charCounts) writer.writeVarInt(c);
			writer.writeString(f.chars);

			if (color) {
				if (f.colorRLE && f.colorRLE.length > 0) {
					writer.writeUint8(1);
					writer.writeVarInt(f.colorRLE.length);
					for (const c of f.colorRLE) writer.writeVarInt(c);
				} else {
					writer.writeUint8(0);
				}
			}
		} else if (f.type === 2) { // Delta
			writer.writeVarInt(f.charGaps.length);
			for (const c of f.charGaps) writer.writeVarInt(c);
			writer.writeString(f.chars);

			if (color) {
				if (f.colorGaps && f.colorGaps.length > 0) {
					writer.writeUint8(1);
					writer.writeVarInt(f.colorGaps.length);
					for (const c of f.colorGaps) writer.writeVarInt(c);
					for (const v of f.colorVals) writer.writeVarInt(v);
				} else {
					writer.writeUint8(0);
				}
			}
		}
	}

	return writer.toBuffer();
}

/**
 * Generate the web bundle files (batch mode – all frames in memory).
 */
export async function generateBundle({ frames, width, height, fps, color, outputDir, render }) {
	await mkdir(outputDir, { recursive: true });

	const renderConfig = render || { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };
	const palette = renderConfig.mode === 'palette' ? renderConfig.palette : null;
	const qStep = palette ? 1 : 16;  // 16 for truecolor — fewer unique colours

	// Build colour dictionary
	let dictInfo = null;
	let dictArray = null;
	if (color) {
		dictInfo = buildColorDict(frames, qStep, palette);
		dictArray = dictInfo.dict;
	}

	// V5 compact binary encoding
	const encodedFrames = deltaEncodeFramesBinary(frames, color, dictInfo);

	// Generate binary buffer directly
	const rawBin = buildBinaryPayload(width, height, fps, color, renderConfig, dictArray, encodedFrames);

	// Gzip the binary payload (native zlib)
	const compressed = gzipSync(rawBin, { level: 9 });

	const { bundleJS, bundleSize } = buildBundleJS(compressed);
	const demoHTML = buildDemoHTML(width, height, frames.length, fps);

	const bundlePath = join(outputDir, 'bundle.js');
	const htmlPath = join(outputDir, 'demo.html');

	await Promise.all([
		writeFile(bundlePath, bundleJS, 'utf-8'),
		writeFile(htmlPath, demoHTML, 'utf-8'),
	]);

	const rawSize = frames.reduce((sum, f) => sum + f.chars.length, 0);

	return {
		bundlePath, htmlPath,
		stats: {
			totalFrames: frames.length,
			rawCharsSize: rawSize,
			bundleSize,
			jsonUncompressed: rawBin.length,
			compressionRatio: rawBin.length > 0 ? (bundleSize / rawBin.length).toFixed(2) : 'N/A',
			gzipRatio: rawBin.length > 0 ? ((compressed.length / rawBin.length) * 100).toFixed(1) + '%' : 'N/A',
		},
	};
}

/**
 * Streaming bundle writer – frames arrive one at a time.
 */
export function createBundleWriter({ width, height, fps, color, outputDir, render }) {
	const bundlePath = join(outputDir, 'bundle.js');
	const htmlPath = join(outputDir, 'demo.html');

	const renderConfig = render || { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };
	const palette = renderConfig.mode === 'palette' ? renderConfig.palette : null;
	const qStep = palette ? 1 : 16;

	// Accumulate frames in memory for delta encoding pass
	const allFrames = [];
	let rawCharsSize = 0;

	const writeFrame = (frame) => {
		allFrames.push(frame);
		rawCharsSize += frame.chars.length;
	};

	const finalize = async () => {
		const includeColor = color && allFrames.some((f) => f.colors);

		// Build colour dictionary across all frames
		let dictInfo = null;
		let dictArray = null;
		if (includeColor) {
			dictInfo = buildColorDict(allFrames, qStep, palette);
			dictArray = dictInfo.dict;
		}

		// V5 compact binary encoding
		const encodedFrames = deltaEncodeFramesBinary(allFrames, includeColor, dictInfo);

		// Generate binary buffer directly
		const rawBin = buildBinaryPayload(width, height, fps, includeColor, renderConfig, dictArray, encodedFrames);

		const compressed = gzipSync(rawBin, { level: 9 });

		const { bundleJS, bundleSize } = buildBundleJS(compressed);

		await writeFile(bundlePath, bundleJS, 'utf-8');
		await writeFile(htmlPath, buildDemoHTML(width, height, allFrames.length, fps), 'utf-8');



		return {
			bundlePath,
			htmlPath,
			stats: {
				totalFrames: allFrames.length,
				rawCharsSize,
				bundleSize,
				jsonUncompressed: rawBin.length,
				compressionRatio: rawBin.length > 0 ? (bundleSize / rawBin.length).toFixed(2) : 'N/A',
				gzipRatio: rawBin.length > 0 ? ((compressed.length / rawBin.length) * 100).toFixed(1) + '%' : 'N/A',
			},
		};
	};

	return { writeFrame, finalize, bundlePath, htmlPath };
}

/**
 * Build the bundle.js contents.
 * Uses base64-encoded gzip + native DecompressionStream in the player (no pako).
 */
function buildBundleJS(compressedBuf) {
	const b64 = Buffer.from(compressedBuf).toString('base64');
	const js = [
		'// ascii-fy bundle v5 – purely binary + gzip (native decompress)',
		`var __ASCII_COMPRESSED__="${b64}";`,
		'',
		PLAYER_SOURCE,
		'',
		'if(typeof window!=="undefined"){window.AsciiPlayer=AsciiPlayer;window.__ASCII_COMPRESSED__=__ASCII_COMPRESSED__;}',
		'if(typeof module!=="undefined"){module.exports={AsciiPlayer:AsciiPlayer,compressed:__ASCII_COMPRESSED__};}',
	].join('\n');

	return { bundleJS: js, bundleSize: Buffer.byteLength(js, 'utf-8') };
}

function buildDemoHTML(width, height, frameCount, fps) {
	return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>ascii-fy Player</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    html, body {
      width: 100%; height: 100%;
      background: transparent;
      display: flex;
      align-items: center;
      justify-content: center;
      overflow: hidden;
    }
    #player-container {
      max-width: 100%;
      max-height: 100%;
      overflow: auto;
    }
    #player-container pre {
      line-height: 1;
      font-size: clamp(4px, 1vw, 12px);
    }
  </style>
</head>
<body>
  <div id="player-container"></div>
  <script src="bundle.js"><\/script>
  <script>
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'set-bg') {
        document.body.style.background = e.data.color || 'transparent';
      }
    });
    AsciiPlayer.fromCompressed(__ASCII_COMPRESSED__).then(function(player) {
      player.mount(document.getElementById('player-container'));
      player.play();
    });
  <\/script>
</body>
</html>`;
}

