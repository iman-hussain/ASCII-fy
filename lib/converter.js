/**
 * ascii-fy – Stream-based video-to-ASCII converter engine.
 *
 * Spawns FFmpeg as a child process, reads raw RGB24 frames from stdout,
 * and converts every pixel to an ASCII character via luminance mapping.
 * No intermediate files are ever written to disk.
 */

import { spawn } from 'node:child_process';
import ffmpegPath from 'ffmpeg-static';
import ffprobeStatic from 'ffprobe-static';
import { CHAR_RAMP, BLOCK_RAMP } from './render.js';
import { CELL_W, CELL_H } from './gif.js';


/**
 * Probe the input video to discover its dimensions and frame rate.
 * Returns { width, height, fps, duration }.
 */
export async function probeVideo(inputPath) {
  const ffprobePath = typeof ffprobeStatic === 'string'
    ? ffprobeStatic
    : ffprobeStatic?.path || ffmpegPath.replace(/ffmpeg(\.exe)?$/i, 'ffprobe$1');

  return new Promise((resolve, reject) => {
    const args = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height,r_frame_rate:format=duration',
      '-of', 'json',
      inputPath,
    ];

    const proc = spawn(ffprobePath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';

    proc.stdout.on('data', (chunk) => { out += chunk; });
    proc.stderr.on('data', (chunk) => { err += chunk; });

    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`ffprobe exited ${code}: ${err}`));
      try {
        const info = JSON.parse(out);
        const stream = info.streams[0];
        const [num, den] = stream.r_frame_rate.split('/').map(Number);
        resolve({
          width: stream.width,
          height: stream.height,
          fps: den ? num / den : num,
          duration: info.format ? Number(info.format.duration) : undefined,
        });
      } catch (e) {
        reject(new Error(`Failed to parse ffprobe output: ${e.message}`));
      }
    });

    proc.on('error', reject);
  });
}

/**
 * Convert a video file to an array of ASCII frames (streaming).
 *
 * @param {object}   opts
 * @param {string}   opts.inputPath   – Path to input video file.
 * @param {number}   opts.outputWidth – Target ASCII width (characters).
 * @param {boolean}  opts.color       – If true, store per-char RGB values.
 * @param {function} [opts.onFrame]   – Callback invoked with (frameIndex, asciiFrame).
 * @returns {Promise<{ frames: any[], width: number, height: number, fps: number }>}
 */
export async function convert({ inputPath, outputWidth = 100, color = false, onFrame, startTime, endTime, meta, collectFrames = true, targetFps, tone, charMode = 'ascii' }) {
  // 1. Probe video for metadata
  const info = (meta && meta.width && meta.height)
    ? meta
    : await probeVideo(inputPath);

  // Compute output height and upscale sampling grid for better block averaging.
  const scaledHeight = Math.round((outputWidth / info.width) * info.height);
  // Correct for GIF cell aspect ratio (CELL_W × CELL_H per character)
  const asciiHeight = Math.max(1, Math.round(scaledHeight * CELL_W / CELL_H));
  // Ensure even (FFmpeg -2 requirement)
  const evenHeight = asciiHeight % 2 === 0 ? asciiHeight : asciiHeight + 1;
  // ASCII mode uses 4× oversampling for 2×2 quadrant edge detection;
  // block mode only needs average colour so 2× is sufficient.
  const sampleFactor = charMode === 'block' ? 2 : 4;
  const scaledW = outputWidth * sampleFactor;
  const scaledH = evenHeight * sampleFactor;

  // 2. Spawn FFmpeg – stream raw RGB24 pixels to stdout
  const filters = [`scale=${scaledW}:${scaledH}:flags=lanczos`];
  if (targetFps) filters.push(`fps=${targetFps}`);
  if (tone) {
    const contrast = typeof tone.contrast === 'number' ? tone.contrast : 1.0;
    const brightness = typeof tone.brightness === 'number' ? tone.brightness : 0.0;
    const saturation = typeof tone.saturation === 'number' ? tone.saturation : 1.0;
    const gamma = typeof tone.gamma === 'number' ? tone.gamma : 1.0;
    filters.push(`eq=contrast=${contrast}:brightness=${brightness}:saturation=${saturation}:gamma=${gamma}`);
  }

  const ffmpegArgs = [
    ...(typeof startTime === 'number' ? ['-ss', String(startTime)] : []),
    '-i', inputPath,
    ...(typeof endTime === 'number' ? ['-t', String(Math.max(0, endTime - (startTime || 0)))] : []),
    '-f', 'image2pipe',
    '-vcodec', 'rawvideo',
    '-pix_fmt', 'rgb24',
    '-vf', filters.join(','),
    '-',
  ];

  const proc = spawn(ffmpegPath, ffmpegArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const frameByteLength = scaledW * scaledH * 3; // 3 bytes per pixel (RGB)
  const frames = collectFrames ? [] : null;
  let buffer = Buffer.alloc(0);
  let frameIndex = 0;

  return new Promise((resolve, reject) => {
    proc.stdout.on('data', (chunk) => {
      // Accumulate data – handles partial & multi-frame chunks
      buffer = Buffer.concat([buffer, chunk]);

      // Process every complete frame sitting in the buffer
      while (buffer.length >= frameByteLength) {
        const pixels = new Uint8Array(buffer.buffer, buffer.byteOffset, frameByteLength);
        const frame = processFrame(pixels, scaledW, scaledH, outputWidth, evenHeight, sampleFactor, color, charMode);
        if (frames) frames.push(frame);

        if (onFrame) onFrame(frameIndex, frame);
        frameIndex++;

        // Advance past the consumed frame
        buffer = buffer.subarray(frameByteLength);
      }
    });

    let stderrOutput = '';
    proc.stderr.on('data', (chunk) => { stderrOutput += chunk; });

    proc.on('close', (code) => {
      if (code !== 0 && frames && frames.length === 0) {
        return reject(new Error(`FFmpeg exited with code ${code}: ${stderrOutput.slice(-500)}`));
      }
      const duration = typeof endTime === 'number'
        ? Math.max(0, endTime - (startTime || 0))
        : info.duration;

      resolve({
        frames: frames || [],
        width: outputWidth,
        height: evenHeight,
        fps: targetFps || info.fps,
        duration,
      });
    });

    proc.on('error', reject);
  });
}

// Previous-frame state for character stabilisation
let _prevFrameColors = null;
let _prevFrameChars = null;

// Squared RGB distance threshold below which a cell's colour is "the same".
const COLOR_STABLE_THRESHOLD = 18 * 18 * 3; // ~18 per channel

// ─── Edge-detection ASCII character selection ────────────────────────────────
// For each cell we compute 2×2 quadrant luminances (TL/TR/BL/BR).
// If the quadrants are similar (low range) → density char from CHAR_RAMP.
// Otherwise classify the bright-quadrant pattern → edge/shape character.

const EDGE_THRESHOLD = 30; // min quadrant lum range to count as an edge

// 4-bit lookup: bit3=TL bit2=TR bit1=BL bit0=BR  (1 = brighter than avg)
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

function selectEdgeChar(tl, tr, bl, br) {
  const avg = (tl + tr + bl + br) / 4;
  if (avg < 8) return ' ';

  const range = Math.max(tl, tr, bl, br) - Math.min(tl, tr, bl, br);

  // Uniform → density character
  if (range < EDGE_THRESHOLD) {
    const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
    return CHAR_RAMP[idx];
  }

  // Classify each quadrant relative to the average
  const pattern = ((tl > avg ? 1 : 0) << 3) |
                  ((tr > avg ? 1 : 0) << 2) |
                  ((bl > avg ? 1 : 0) << 1) |
                   (br > avg ? 1 : 0);

  // Degenerate cases (all same side of avg) → density
  if (pattern === 0 || pattern === 15) {
    const idx = Math.min(CHAR_RAMP.length - 1, Math.floor((avg / 255) * CHAR_RAMP.length));
    return CHAR_RAMP[idx];
  }

  return EDGE_TABLE[pattern];
}

// ─── Frame processor ─────────────────────────────────────────────────────────

/**
 * Process a single raw RGB24 frame into ASCII data.
 */
function processFrame(pixels, scaledW, scaledH, outW, outH, sampleFactor, color, charMode) {
  const totalChars = outW * outH;
  const charsArr = new Array(totalChars);
  let colors;

  if (color) {
    colors = new Array(totalChars);
  }

  const blockW = sampleFactor;
  const blockH = sampleFactor;
  const denom = blockW * blockH;
  const halfW = blockW >> 1;
  const halfH = blockH >> 1;
  const qDenom = halfW * halfH;
  const useBlocks = charMode === 'block';

  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      let rSum = 0;
      let gSum = 0;
      let bSum = 0;
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
          rSum += pr;
          gSum += pg;
          bSum += pb;

          // Accumulate quadrant luminances for edge detection (ascii mode)
          if (!useBlocks) {
            const lum = 0.2126 * pr + 0.7152 * pg + 0.0722 * pb;
            if (by < halfH) {
              if (bx < halfW) qTL += lum; else qTR += lum;
            } else {
              if (bx < halfW) qBL += lum; else qBR += lum;
            }
          }
        }
      }

      const r = rSum / denom;
      const g = gSum / denom;
      const b = bSum / denom;

      const i = y * outW + x;
      const rR = Math.round(r);
      const gR = Math.round(g);
      const bR = Math.round(b);

      // Colour stabilisation — reuse previous char if colour barely changed
      if (_prevFrameColors && _prevFrameChars && _prevFrameColors[i]) {
        const pc = _prevFrameColors[i];
        const dr = rR - pc[0];
        const dg = gR - pc[1];
        const db = bR - pc[2];
        if (dr * dr + dg * dg + db * db < COLOR_STABLE_THRESHOLD) {
          charsArr[i] = _prevFrameChars[i];
          if (color) colors[i] = [rR, gR, bR];
          continue;
        }
      }

      let ch;
      if (useBlocks) {
        // Block mode: pure luminance → block ramp
        const yLum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        const ci = Math.min(BLOCK_RAMP.length - 1, Math.floor((yLum / 255) * BLOCK_RAMP.length));
        ch = BLOCK_RAMP[ci];
      } else {
        // ASCII mode: quadrant-based edge detection
        ch = selectEdgeChar(qTL / qDenom, qTR / qDenom, qBL / qDenom, qBR / qDenom);
      }
      charsArr[i] = ch;

      if (color) {
        colors[i] = [rR, gR, bR];
      }
    }
  }

  const chars = charsArr.join('');

  // Store for next frame's stabilisation check
  _prevFrameColors = color ? colors : null;
  _prevFrameChars = charsArr;

  return color ? { chars, colors } : { chars };
}
