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

  // Delta + RLE encode
  const encodedFrames = deltaEncodeFrames(frames, color, dictInfo);

  const payload = {
    v: 2,
    frames: encodedFrames,
    width, height, fps,
    color: !!color,
    render: renderConfig,
  };
  if (dictArray && dictArray.length) payload.colorDict = dictArray;

  // Gzip the JSON payload (native zlib — no pako at build time)
  const jsonStr = JSON.stringify(payload);
  const compressed = gzipSync(Buffer.from(jsonStr), { level: 9 });

  const { bundleJS, bundleSize } = buildBundleJS(compressed);
  const demoHTML = buildDemoHTML(width, height, frames.length, fps);

  const bundlePath = join(outputDir, 'bundle.js');
  const htmlPath = join(outputDir, 'demo.html');

  await Promise.all([
    writeFile(bundlePath, bundleJS, 'utf-8'),
    writeFile(htmlPath, demoHTML, 'utf-8'),
  ]);

  const rawSize = frames.reduce((sum, f) => sum + f.chars.length, 0);
  const jsonSize = Buffer.byteLength(jsonStr, 'utf-8');

  return {
    bundlePath, htmlPath,
    stats: {
      totalFrames: frames.length,
      rawCharsSize: rawSize,
      bundleSize,
      jsonUncompressed: jsonSize,
      compressionRatio: jsonSize > 0 ? (bundleSize / jsonSize).toFixed(2) : 'N/A',
      gzipRatio: jsonSize > 0 ? ((compressed.length / jsonSize) * 100).toFixed(1) + '%' : 'N/A',
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

    // Delta + RLE encode
    const encodedFrames = deltaEncodeFrames(allFrames, includeColor, dictInfo);

    const payload = {
      v: 2,
      frames: encodedFrames,
      width,
      height,
      fps,
      color: !!includeColor,
      render: renderConfig,
    };
    if (dictArray && dictArray.length) {
      payload.colorDict = dictArray;
    }

    const jsonStr = JSON.stringify(payload);
    const compressed = gzipSync(Buffer.from(jsonStr), { level: 9 });

    const { bundleJS, bundleSize } = buildBundleJS(compressed);

    await writeFile(bundlePath, bundleJS, 'utf-8');
    await writeFile(htmlPath, buildDemoHTML(width, height, allFrames.length, fps), 'utf-8');

    const jsonSize = Buffer.byteLength(jsonStr, 'utf-8');

    return {
      bundlePath,
      htmlPath,
      stats: {
        totalFrames: allFrames.length,
        rawCharsSize,
        bundleSize,
        jsonUncompressed: jsonSize,
        compressionRatio: jsonSize > 0 ? (bundleSize / jsonSize).toFixed(2) : 'N/A',
        gzipRatio: jsonSize > 0 ? ((compressed.length / jsonSize) * 100).toFixed(1) + '%' : 'N/A',
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
    '// ascii-fy bundle v3 – gzip + delta + colour dict (native decompress)',
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
    body {
      background: #111;
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      font-family: sans-serif;
      color: #ccc;
    }
    h1 { margin-bottom: 12px; font-size: 1.2rem; color: #0f0; }
    #player-container { max-width: 95vw; overflow: auto; }
    .controls { margin-top: 12px; }
    .controls button {
      background: #222;
      color: #0f0;
      border: 1px solid #0f0;
      padding: 8px 20px;
      margin: 0 4px;
      cursor: pointer;
      font-size: 0.9rem;
      border-radius: 4px;
    }
    .controls button:hover { background: #0f0; color: #111; }
    .info { margin-top: 10px; font-size: 0.75rem; color: #666; }
  </style>
</head>
<body>
  <h1>ascii-fy</h1>
  <div id="player-container"></div>
  <div class="controls">
    <button id="btn-play">&#9654; Play</button>
    <button id="btn-stop">&#9632; Stop</button>
  </div>
  <div class="info">
    ${width}&times;${height} &middot; ${frameCount} frames &middot; ${fps.toFixed(1)} fps
  </div>

  <script src="bundle.js"><\/script>
  <script>
    /* Listen for background-colour messages from parent (GUI iframe) */
    window.addEventListener('message', function(e) {
      if (e.data && e.data.type === 'set-bg') {
        document.body.style.background = e.data.color || '#111';
      }
    });
    AsciiPlayer.fromCompressed(__ASCII_COMPRESSED__).then(function(player) {
      player.mount(document.getElementById('player-container'));
      document.getElementById('btn-play').addEventListener('click', function() { player.play(); });
      document.getElementById('btn-stop').addEventListener('click', function() { player.stop(); });
      player.play();
    });
  <\/script>
</body>
</html>`;
}

