#!/usr/bin/env node

/**
 * ascii-fy – CLI entry point.
 *
 * Supports two modes:
 *
 *  1. Interactive (no args):  `node index.js`
 *     Prompts for file, width, fps, trim, colour mode, etc.
 *
 *  2. Fast CLI flags:  `node index.js input/dog.mp4 --width 120 --fps 30 --mode truecolor`
 *     Skips prompts entirely – great for rapid iteration.
 *
 * Flags:
 *   <filename>            Path to video file (positional, first non-flag arg)
 *   -w, --width  <n>      Output width in characters    (default: 100)
 *   -f, --fps    <n>      Output frame rate              (default: 24)
 *   -m, --mode   <mode>   Colour mode: truecolor | mono | palette | kmeans  (default: truecolor)
 *   -d, --depth  <n>      Palette colour count: 2–64         (default: 16)
 *   -p, --palette <name>  Preset palette: realistic | grayscale | sunset | ocean | neon | forest
 *   --fg <hex>            Foreground colour for mono mode      (default: #00ff00)
 *   --bg <hex>            Background colour for mono mode      (default: #000000)
 *   -s, --start  <sec>    Trim start time in seconds
 *   -e, --end    <sec>    Trim end time in seconds
 *   --no-gif              Skip GIF generation
 *   --no-open             Don't auto-open output
 *   -h, --help            Show help
 */

import { readdir, access, mkdir } from 'node:fs/promises';
import { resolve, extname, basename, dirname, join } from 'node:path';
import { spawn } from 'node:child_process';
import inquirer from 'inquirer';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { convert, probeVideo } from './lib/converter.js';
import { createBundleWriter } from './lib/bundler.js';
import { previewInTerminal } from './lib/preview.js';
import { createAsciiGifWriter } from './lib/gif.js';
import { makeGradientPalette, makeGrayscalePalette, makeRealisticPalette } from './lib/render.js';
import { adaptiveTone, sampleVideoLuminance } from './lib/tone.js';
import { extractPaletteFromVideo } from './lib/kmeans.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.mov', '.webm', '.gif', '.avi', '.mkv', '.flv']);

// ─── Helpers ────────────────────────────────────────────────────────────────

async function scanForVideos(dir) {
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    return entries
      .filter((e) => e.isFile() && VIDEO_EXTENSIONS.has(extname(e.name).toLowerCase()))
      .map((e) => e.name);
  } catch {
    return [];
  }
}

async function ensureIoDirs(baseDir) {
  const inputDir = join(baseDir, 'input');
  const outputDir = join(baseDir, 'output');

  await Promise.all([
    mkdir(inputDir, { recursive: true }),
    mkdir(outputDir, { recursive: true }),
  ]);

  return { inputDir, outputDir };
}

function safeOutputName(inputPath) {
  const base = basename(inputPath, extname(inputPath));
  return base.replace(/[<>:"/\\|?*]+/g, '_').trim() || 'output';
}

/**
 * Build a descriptive output folder/file name from conversion options.
 * Pattern: <basename>_<mode>[_<depth>c][_<palette>]_<width>w_<fps>fps_<charMode>
 */
function buildOutputName(inputPath, { mode, depth, palette, width, fps, charMode }) {
  const base = safeOutputName(inputPath);
  const parts = [base];
  parts.push(mode || 'truecolor');
  if ((mode === 'palette' || mode === 'kmeans') && depth) parts.push(`${depth}c`);
  if (mode === 'palette' && palette) parts.push(palette);
  if (width) parts.push(`${width}w`);
  if (fps) parts.push(`${fps}fps`);
  parts.push(charMode || 'ascii');
  return parts.join('_');
}

function parseHexColor(hex, fallback) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return fallback;
  return `#${m[1].toLowerCase()}`;
}

function validateHexColor(val) {
  return /^#?[0-9a-fA-F]{6}$/.test(val) || 'Use hex format like #00ff00.';
}

function ensureHexOrFallback(val, fallback) {
  return /^#?[0-9a-fA-F]{6}$/.test(val || '') ? val : fallback;
}

function hexToRgbArray(hex, fallback) {
  const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
  if (!m) return fallback;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function formatSeconds(sec) {
  if (!sec || Number.isNaN(sec)) return 'unknown';
  const minutes = Math.floor(sec / 60);
  const seconds = Math.floor(sec % 60);
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

function openFileDefault(path) {
  const platform = process.platform;
  if (platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', path], { stdio: 'ignore', detached: true });
  } else if (platform === 'darwin') {
    spawn('open', [path], { stdio: 'ignore', detached: true });
  } else {
    spawn('xdg-open', [path], { stdio: 'ignore', detached: true });
  }
}

function validateSecondsInput(val, { min = 0, max = undefined } = {}) {
  const num = Number(val);
  if (!Number.isFinite(num)) return 'Please enter a valid number.';
  if (num < min) return `Value must be ≥ ${min}.`;
  if (typeof max === 'number' && num > max) return `Value must be ≤ ${max.toFixed(2)}.`;
  return true;
}

// ─── Main ───────────────────────────────────────────────────────────────────

// ─── CLI argument parser ────────────────────────────────────────────────────

function parseCliArgs(argv) {
  const args = argv.slice(2); // skip node + script
  const opts = {
    inputFile: null,
    width: null,
    fps: null,
    mode: null,        // truecolor | mono | palette | kmeans
    depth: null,       // 2–64
    palette: null,     // preset name
    fg: null,
    bg: null,
    start: null,
    end: null,
    charMode: null,   // ascii | block
    noGif: false,
    noOpen: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const next = () => args[++i];

    if (a === '-h' || a === '--help') { opts.help = true; }
    else if (a === '-w' || a === '--width')   { opts.width   = Number(next()); }
    else if (a === '-f' || a === '--fps')     { opts.fps     = Number(next()); }
    else if (a === '-m' || a === '--mode')    { opts.mode    = next(); }
    else if (a === '-d' || a === '--depth')   { opts.depth   = Number(next()); }
    else if (a === '-p' || a === '--palette') { opts.palette = next(); }
    else if (a === '--fg')      { opts.fg = next(); }
    else if (a === '--bg')      { opts.bg = next(); }
    else if (a === '-s' || a === '--start')   { opts.start = Number(next()); }
    else if (a === '-e' || a === '--end')     { opts.end   = Number(next()); }
    else if (a === '-g' || a === '--char-mode') { opts.charMode = next(); }
    else if (a === '--no-gif')  { opts.noGif  = true; }
    else if (a === '--no-open') { opts.noOpen = true; }
    else if (!a.startsWith('-') && !opts.inputFile) {
      opts.inputFile = a;
    }
  }

  return opts;
}

function printHelp() {
  console.log(`
  ascii-fy – Video → ASCII Art CLI

  Usage:
    node index.js                              Interactive mode
    node index.js <file> [options]             Fast CLI mode

  Options:
    <file>                  Path to video file (positional)
    -w, --width  <n>        Output width in characters    (default: 100)
    -f, --fps    <n>        Frame rate                    (default: 24)
    -m, --mode   <mode>     truecolor | mono | palette | kmeans
    -d, --depth  <n>        Palette colours: 2–64 (any number)
    -p, --palette <name>    realistic | grayscale | sunset | ocean | neon | forest
        --fg <hex>          Foreground for mono mode      (default: #00ff00)
        --bg <hex|auto>     Player background colour       (default: #000000)
    -g, --char-mode <mode>  Character mode: ascii | block  (default: ascii)
    -s, --start  <sec>      Trim start
    -e, --end    <sec>      Trim end
        --no-gif            Skip GIF generation
        --no-open           Don't auto-open output files
    -h, --help              Show this help

  Examples:
    node index.js input/dog.mp4 --mode truecolor
    node index.js input/dog.mp4 -w 120 -f 30 -m palette -d 16 -p sunset
    node index.js input/dog.mp4 -m kmeans -d 32
    node index.js input/dog.mp4 -m mono --fg "#0f0" --bg "#000"
    node index.js input/dog.mp4 -s 2 -e 8 -w 80
`);
}

const gradientPresets = {
  realistic: [ [12, 18, 30], [40, 80, 140], [120, 160, 120], [200, 170, 120], [220, 220, 210] ],
  grayscale: [ [0, 0, 0], [255, 255, 255] ],
  sunset:    [ [255, 94, 58], [255, 149, 0], [255, 204, 0] ],
  ocean:     [ [0, 24, 72], [0, 118, 255], [0, 217, 255] ],
  neon:      [ [57, 255, 20], [0, 255, 255], [255, 0, 255] ],
  forest:    [ [16, 64, 32], [34, 139, 34], [154, 205, 50] ],
};

function buildPresetPalette(name, colorCount) {
  if (name === 'grayscale') return makeGrayscalePalette(colorCount);
  if (name === 'realistic') return makeRealisticPalette(colorCount);
  const stops = gradientPresets[name] || gradientPresets.realistic;
  return makeGradientPalette(stops, colorCount);
}

/**
 * Shared conversion engine used by both CLI and interactive paths.
 */
async function runConversionEngine({ inputPath, outputWidth, outputFps, startTime, endTime, meta, tone, render, outputJobDir, outputName, inputExt, skipGif, skipOpen }) {
  const duration = typeof endTime === 'number'
    ? Math.max(0, endTime - (startTime || 0))
    : meta.duration;
  const effectiveFps = outputFps || meta.fps || 24;
  const expectedFrames = duration && effectiveFps
    ? Math.max(1, Math.round(duration * effectiveFps))
    : null;

  const spinner = ora(`Preparing conversion for ${basename(inputPath)}…`).start();
  let frameCount = 0;

  const bar = expectedFrames
    ? new cliProgress.SingleBar({
      format: 'Converting |{bar}| {percentage}% | {value}/{total} frames | ETA: {eta}s',
      hideCursor: true,
    }, cliProgress.Presets.shades_classic)
    : null;

  if (bar) bar.start(expectedFrames, 0);

  const includeColors = render.mode !== 'mono';
  const gifPath = join(outputJobDir, 'preview.gif');
  let bundleWriter = null;
  let gifWriter = null;
  let frameHeight = null;

  let result;
  try {
    if (bar) spinner.stop();
    result = await convert({
      inputPath,
      outputWidth,
      color: includeColors,
      startTime,
      endTime,
      meta,
      targetFps: outputFps,
      tone,
      charMode: render.charMode || 'ascii',
      collectFrames: false,
      onFrame: (idx, frame) => {
        frameCount = idx + 1;
        if (bar) {
          bar.update(Math.min(frameCount, expectedFrames || frameCount));
        } else {
          spinner.text = `Converting… frame ${frameCount}`;
        }

        if (!bundleWriter) {
          frameHeight = Math.max(1, Math.round(frame.chars.length / outputWidth));
          bundleWriter = createBundleWriter({
            width: outputWidth, height: frameHeight, fps: effectiveFps,
            color: includeColors, outputDir: outputJobDir, render,
          });
          if (!skipGif) {
            gifWriter = createAsciiGifWriter({
              width: outputWidth, height: frameHeight, fps: effectiveFps,
              render, outputPath: gifPath,
            });
          }
        }
        bundleWriter.writeFrame(frame);
        if (gifWriter) gifWriter.writeFrame(frame);
      },
    });
  } catch (err) {
    if (bar) bar.stop();
    spinner.fail(`Conversion failed: ${err.message}`);
    process.exit(1);
  }

  if (bar) bar.stop();

  if (gifWriter) {
    const gifSpinner = ora('Finalizing ASCII GIF preview…').start();
    try {
      await gifWriter.finalize();
      gifSpinner.succeed('GIF preview generated!');
      console.log(`\n  📄  ${gifPath}`);
      if (!skipOpen) openFileDefault(gifPath);
    } catch (err) {
      gifSpinner.fail(`GIF generation failed: ${err.message}`);
    }
  }

  const bundleSpinner = ora('Finalizing web bundle…').start();
  let bundleInfo;
  try {
    bundleInfo = bundleWriter ? await bundleWriter.finalize() : null;
    bundleSpinner.succeed('Web bundle generated!');
    if (bundleInfo) {
      console.log(`\n  📄  ${bundleInfo.bundlePath}`);
      console.log(`  📄  ${bundleInfo.htmlPath}`);
      console.log(`  🎨  ${render.label}`);
      console.log(`  📊  ${bundleInfo.stats.totalFrames} frames | Bundle: ${formatBytes(bundleInfo.stats.bundleSize)} | Gzip: ${bundleInfo.stats.gzipRatio}\n`);
    }
  } catch (err) {
    bundleSpinner.fail(`Bundle generation failed: ${err.message}`);
    process.exit(1);
  }

  spinner.succeed(`Converted ${frameCount} frames (${result.width}×${result.height} @ ${effectiveFps.toFixed(1)} fps)`);

  return { width: result.width, height: result.height, fps: effectiveFps, gifPath };
}

async function main() {
  const cli = parseCliArgs(process.argv);

  if (cli.help) {
    printHelp();
    process.exit(0);
  }

  const hasCLIFile = !!cli.inputFile;

  console.log('\n  ╔═══════════════════════════╗');
  console.log('  ║   ascii-fy  v2.0.0        ║');
  console.log('  ║   Video → ASCII Art CLI    ║');
  console.log('  ╚═══════════════════════════╝\n');

  if (hasCLIFile) {
    // ── Fast CLI path ──────────────────────────────────────────────────
    await runFromCLI(cli);
  } else {
    // ── Interactive path ────────────────────────────────────────────────
    await runInteractive();
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Fast CLI mode
// ────────────────────────────────────────────────────────────────────────────

async function runFromCLI(cli) {
  const inputPath = resolve(cli.inputFile);

  try {
    await access(inputPath);
  } catch {
    console.error(`  ✖  File not found: ${inputPath}`);
    process.exit(1);
  }

  const cwd = process.cwd();
  const outputDir = join(cwd, 'output');
  await mkdir(outputDir, { recursive: true });

  let meta;
  try {
    meta = await probeVideo(inputPath);
  } catch (err) {
    console.log(`  ⚠  Unable to probe video: ${err.message}`);
    meta = { fps: 24, width: 640, height: 480, duration: undefined };
  }

  const outputWidth = cli.width || 100;
  const outputFps   = cli.fps || 24;
  const startTime   = cli.start ?? undefined;
  const endTime     = cli.end ?? undefined;
  const inputExt    = extname(inputPath).toLowerCase();
  const charMode   = (cli.charMode === 'block') ? 'block' : 'ascii';

  // ── Resolve background colour ──────────────────────────────────────
  let resolvedBg = '#000000';
  if (cli.bg === 'auto') {
    const spinnerBg = ora('Detecting optimal background colour…').start();
    try {
      const bgStats = await sampleVideoLuminance(inputPath, outputWidth, meta);
      resolvedBg = bgStats.mean > 0.6 ? '#f0f0f0' : bgStats.mean > 0.4 ? '#1a1a2e' : '#0a0a0a';
      spinnerBg.succeed(`Auto background: ${resolvedBg}`);
    } catch {
      spinnerBg.fail('Could not detect background, using #000000');
    }
  } else if (cli.bg) {
    resolvedBg = parseHexColor(cli.bg, '#000000');
  }

  // ── Build render config ──────────────────────────────────────────────
  const mode = cli.mode || 'truecolor';
  const colorCount = cli.depth || 16;
  let render;
  let tone;

  if (mode === 'mono') {
    render = {
      mode: 'mono',
      palette: null,
      charMode,
      theme: { fg: cli.fg || '#00ff00', bg: resolvedBg },
      label: 'Monochrome',
    };
    tone = { contrast: 1.15, brightness: 0.02, saturation: 1.0, gamma: 1.05 };
  } else if (mode === 'palette') {
    const presetName = cli.palette || 'realistic';
    const palette = buildPresetPalette(presetName, colorCount);

    // Adaptive tone mapping for palette modes
    const spinner = ora('Sampling video for adaptive tone…').start();
    const stats = await sampleVideoLuminance(inputPath, outputWidth, meta);
    tone = adaptiveTone(colorCount, stats, inputExt);
    spinner.succeed(`Adaptive tone: contrast=${tone.contrast.toFixed(2)} brightness=${tone.brightness.toFixed(3)} gamma=${tone.gamma.toFixed(2)} saturation=${tone.saturation.toFixed(2)}`);

    render = {
      mode: 'palette',
      palette,
      charMode,
      theme: { fg: '#111111', bg: resolvedBg },
      label: `${presetName} (${colorCount} colours)`,
    };
  } else if (mode === 'kmeans') {
    // ML-based palette extraction
    const spinner = ora(`Extracting optimal ${colorCount}-colour palette via k-means…`).start();
    const palette = await extractPaletteFromVideo(inputPath, outputWidth, meta, colorCount);
    if (!palette) {
      spinner.fail('Could not sample video for k-means. Falling back to grayscale.');
      render = {
        mode: 'palette',
        palette: makeGrayscalePalette(colorCount),
        charMode,
        theme: { fg: '#111111', bg: resolvedBg },
        label: `Grayscale fallback (${colorCount} colours)`,
      };
    } else {
      spinner.succeed(`k-means extracted ${palette.length} optimal colours from source`);
      render = {
        mode: 'palette',
        palette,
        charMode,
        theme: { fg: '#111111', bg: resolvedBg },
        label: `k-means optimal (${colorCount} colours)`,
      };
    }

    // Adaptive tone for the extracted palette
    const stats = await sampleVideoLuminance(inputPath, outputWidth, meta);
    tone = adaptiveTone(colorCount, stats, inputExt);
  } else {
    // truecolor
    render = {
      mode: 'truecolor',
      palette: null,
      charMode,
      theme: { fg: '#111111', bg: resolvedBg },
      label: 'Truecolor (source)',
    };
    tone = inputExt === '.gif'
      ? { contrast: 1.35, brightness: 0.04, saturation: 1.2, gamma: 1.1 }
      : { contrast: 1.15, brightness: 0.02, saturation: 1.05, gamma: 1.05 };
  }

  // ── Build output folder from base filename ──────────────────────────
  const outputJobDir = join(outputDir, safeOutputName(inputPath));
  await mkdir(outputJobDir, { recursive: true });

  // ── Run conversion ───────────────────────────────────────────────────
  await runConversionEngine({
    inputPath, outputWidth, outputFps, startTime, endTime, meta, tone,
    render, outputJobDir, outputName: safeOutputName(inputPath), inputExt,
    skipGif: cli.noGif, skipOpen: cli.noOpen,
  });
}

// ────────────────────────────────────────────────────────────────────────────
// Interactive mode (original prompts flow)
// ────────────────────────────────────────────────────────────────────────────

async function runInteractive() {
  const cwd = process.cwd();
  const { inputDir: defaultInputDir, outputDir: defaultOutputDir } = await ensureIoDirs(cwd);

  // 1. Discover video files in ./input
  const videos = await scanForVideos(defaultInputDir);

  let inputChoices;
  if (videos.length > 0) {
    inputChoices = [
      ...videos.map((v) => ({ name: v, value: resolve(defaultInputDir, v) })),
      new inquirer.Separator(),
      { name: 'Enter a custom path…', value: '__custom__' },
    ];
  } else {
    inputChoices = [{ name: 'Enter a custom path…', value: '__custom__' }];
  }

  const answers = await inquirer.prompt([
    {
      type: 'list',
      name: 'inputFile',
      message: 'Select a video file:',
      choices: inputChoices,
    },
    {
      type: 'input',
      name: 'customPath',
      message: 'Enter the full path to the video:',
      when: (ans) => ans.inputFile === '__custom__',
      validate: async (val) => {
        try {
          await access(val);
          return true;
        } catch {
          return 'File not found. Please enter a valid path.';
        }
      },
    },
    {
      type: 'number',
      name: 'outputWidth',
      message: 'Output width (characters):',
      default: 100,
      validate: (val) => (val > 0 && val <= 500) || 'Please enter a value between 1 and 500.',
    },
    {
      type: 'input',
      name: 'outputFps',
      message: 'Output frame rate (fps) [recommended: 24/30/42/60]:',
      default: 24,
      validate: (val) => {
        const num = Number(val);
        if (!Number.isFinite(num)) return 'Please enter a valid number.';
        if (num < 1 || num > 120) return 'Please enter a value between 1 and 120.';
        return true;
      },
      filter: (val) => Number(val),
    },
    {
      type: 'list',
      name: 'charMode',
      message: 'Character mode:',
      choices: [
        { name: 'ASCII (edge-aware shapes: / \\ | _ - L J)', value: 'ascii' },
        { name: 'Block (█▓▒░ solid colour cells)', value: 'block' },
      ],
    },
    // Preview now always runs after conversion
  ]);

  const inputPath = answers.customPath || answers.inputFile;
  const outputWidth = answers.outputWidth;
  const outputFps = answers.outputFps;
  const charMode = answers.charMode || 'ascii';
  const captureColor = true;
  const wantPreview = false;

  const outputDir = join(cwd, 'output');
  await mkdir(outputDir, { recursive: true });

  let meta;
  try {
    meta = await probeVideo(inputPath);
  } catch (err) {
    console.log(`\n  ⚠  Unable to probe video metadata: ${err.message}`);
    meta = { fps: 24, duration: undefined };
  }
  const durationLabel = formatSeconds(meta.duration);

  let startTime;
  let endTime;
  let wantTrim;

  while (true) {
    const trimAnswers = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'trim',
        message: `Trim to a segment? (duration: ${durationLabel})`,
        default: false,
      },
      {
        type: 'input',
        name: 'startTime',
        message: 'Start time (seconds):',
        default: 0,
        when: (ans) => ans.trim,
        validate: (val) => validateSecondsInput(val, { min: 0, max: meta.duration }),
        filter: (val) => Number(val),
      },
      {
        type: 'input',
        name: 'endTime',
        message: 'End time (seconds):',
        default: meta.duration ? Math.floor(meta.duration) : 10,
        when: (ans) => ans.trim,
        validate: (val, ans) => {
          const base = validateSecondsInput(val, { min: 0, max: meta.duration });
          if (base !== true) return base;
          const endVal = Number(val);
          const startVal = Number(ans.startTime);
          if (Number.isFinite(startVal) && endVal <= startVal) return 'End time must be greater than start time.';
          return true;
        },
        filter: (val) => Number(val),
      },
    ]);

    wantTrim = trimAnswers.trim;
    startTime = trimAnswers.startTime;
    endTime = trimAnswers.endTime;

    if (!wantTrim) break;

    const confirmTrim = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'ok',
        message: `Use trim segment ${startTime}s → ${endTime}s?`,
        default: true,
      },
    ]);

    if (confirmTrim.ok) break;
  }

  startTime = wantTrim ? startTime : undefined;
  endTime = wantTrim ? endTime : undefined;

  let render = {
    mode: 'truecolor',
    palette: null,
    charMode,
    theme: { fg: '#111111', bg: '#000000' },
    label: 'Truecolor (source)'
  };

  const inputExt = extname(inputPath).toLowerCase();

  // Default tone – will be recalculated adaptively for palette modes
  let currentTone = inputExt === '.gif'
    ? { contrast: 1.35, brightness: 0.04, saturation: 1.2, gamma: 1.1 }
    : { contrast: 1.15, brightness: 0.02, saturation: 1.05, gamma: 1.05 };

  const runConversion = async ({ renderConfig }) => {
    // Use adaptive tone for palette modes
    let tone = currentTone;
    if (renderConfig.mode === 'palette' && renderConfig.palette) {
      const colorCount = renderConfig.palette.length;
      const stats = await sampleVideoLuminance(inputPath, outputWidth, meta);
      tone = adaptiveTone(colorCount, stats, inputExt);
      console.log(`  🎛  Adaptive tone: contrast=${tone.contrast.toFixed(2)} brightness=${tone.brightness.toFixed(3)} gamma=${tone.gamma.toFixed(2)} sat=${tone.saturation.toFixed(2)}`);
    }
    // Build output folder from base filename
    const outputJobDir = join(outputDir, safeOutputName(inputPath));
    await mkdir(outputJobDir, { recursive: true });
    return runConversionEngine({
      inputPath, outputWidth, outputFps, startTime, endTime, meta, tone,
      render: renderConfig, outputJobDir, outputName: safeOutputName(inputPath), inputExt,
      skipGif: false, skipOpen: false,
    });
  };

  let lastRun = await runConversion({ renderConfig: render });

  // 5. Color options and live preview
  let done = false;
  while (!done) {
    const { action } = await inquirer.prompt([
      {
        type: 'list',
        name: 'action',
        message: 'Color options (post-conversion):',
        choices: [
          { name: 'Truecolor (source, 24-bit)', value: 'truecolor' },
          { name: 'Monochrome (custom fg/bg)', value: 'mono' },
          { name: 'Recolor (4/16/32/64 colors)', value: 'recolor' },
          { name: 'k-means ML palette (auto-extract)', value: 'kmeans' },
          new inquirer.Separator(),
          { name: `Char mode: ${render.charMode === 'block' ? 'block (█▓▒░)' : 'ascii (edges)'} (toggle)`, value: 'toggle-char-mode' },
          { name: 'Open GIF preview', value: 'open-gif' },
          { name: 'Preview in terminal', value: 'preview' },
          { name: 'Regenerate bundle + GIF', value: 'regen' },
          { name: 'Finish', value: 'done' },
        ],
      },
    ]);

    if (action === 'truecolor') {
      render = { ...render, mode: 'truecolor', palette: null, label: 'Truecolor (source)', _paletteName: undefined, _kmeansMode: false };
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'toggle-char-mode') {
      render = { ...render, charMode: render.charMode === 'block' ? 'ascii' : 'block' };
      console.log(`  Char mode set to: ${render.charMode}`);
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'mono') {
      const colorAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'fg',
          message: 'Foreground color (hex):',
          default: ensureHexOrFallback(render.theme.fg, '#00ff00'),
          validate: validateHexColor,
        },
        {
          type: 'input',
          name: 'bg',
          message: 'Background color (hex):',
          default: ensureHexOrFallback(render.theme.bg, '#000000'),
          validate: validateHexColor,
        },
      ]);

      render = {
        ...render,
        mode: 'mono',
        palette: null,
        theme: {
          fg: parseHexColor(colorAnswers.fg, render.theme.fg),
          bg: parseHexColor(colorAnswers.bg, render.theme.bg),
        },
        label: 'Monochrome'
      };
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'recolor') {
      const depthAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'depth',
          message: 'Choose color depth:',
          choices: [
            { name: '4 colours', value: 4 },
            { name: '8 colours', value: 8 },
            { name: '16 colours', value: 16 },
            { name: '32 colours', value: 32 },
            { name: '64 colours', value: 64 },
          ],
        },
      ]);

      const paletteAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'palette',
          message: 'Choose a color palette:',
          choices: [
            { name: 'Realistic (film-like)', value: 'realistic' },
            { name: 'Grayscale', value: 'grayscale' },
            { name: 'Sunset', value: 'sunset' },
            { name: 'Ocean', value: 'ocean' },
            { name: 'Neon', value: 'neon' },
            { name: 'Forest', value: 'forest' },
            { name: 'Custom (3 colors)', value: 'custom' },
          ],
        },
      ]);

      let palette;
      let label;
      const colorCount = depthAnswers.depth;

      if (paletteAnswers.palette === 'custom') {
        const custom = await inquirer.prompt([
          { type: 'input', name: 'c1', message: 'Palette color 1 (hex):', default: '#2c3e50', validate: validateHexColor },
          { type: 'input', name: 'c2', message: 'Palette color 2 (hex):', default: '#95a5a6', validate: validateHexColor },
          { type: 'input', name: 'c3', message: 'Palette color 3 (hex):', default: '#f1c40f', validate: validateHexColor },
        ]);
        const stops = [
          hexToRgbArray(custom.c1, [44, 62, 80]),
          hexToRgbArray(custom.c2, [149, 165, 166]),
          hexToRgbArray(custom.c3, [241, 196, 15]),
        ];
        palette = makeGradientPalette(stops, colorCount);
        label = `Custom palette (${colorCount} colors)`;
      } else if (paletteAnswers.palette === 'grayscale') {
        palette = makeGrayscalePalette(colorCount);
        label = `Grayscale (${colorCount} colors)`;
      } else {
        palette = makeGradientPalette(gradientPresets[paletteAnswers.palette], colorCount);
        label = `${paletteAnswers.palette} (${colorCount} colors)`;
      }

      render = { ...render, mode: 'palette', palette, label, _paletteName: paletteAnswers.palette, _kmeansMode: false };
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'kmeans') {
      const depthAnswers = await inquirer.prompt([
        {
          type: 'list',
          name: 'depth',
          message: 'How many colours for k-means to extract?',
          choices: [
            { name: '4 colours', value: 4 },
            { name: '8 colours', value: 8 },
            { name: '16 colours', value: 16 },
            { name: '32 colours', value: 32 },
            { name: '64 colours', value: 64 },
          ],
        },
      ]);

      const colorCount = depthAnswers.depth;
      const kSpinner = ora(`Running k-means to extract ${colorCount} optimal colours…`).start();
      const mlPalette = await extractPaletteFromVideo(inputPath, outputWidth, meta, colorCount);
      if (mlPalette) {
        kSpinner.succeed(`Extracted ${mlPalette.length} colours via k-means clustering`);
        render = { ...render, mode: 'palette', palette: mlPalette, label: `k-means optimal (${colorCount} colours)`, _paletteName: undefined, _kmeansMode: true };
      } else {
        kSpinner.fail('k-means sampling failed \u2013 using grayscale fallback');
        render = { ...render, mode: 'palette', palette: makeGrayscalePalette(colorCount), label: `Grayscale fallback (${colorCount} colours)`, _paletteName: 'grayscale', _kmeansMode: false };
      }
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'open-gif') {
      if (lastRun.gifPath) {
        openFileDefault(lastRun.gifPath);
      } else {
        console.log('  ⚠  No GIF available. Run a conversion first.');
      }
    } else if (action === 'preview') {
      console.log('  ⚠  Terminal preview removed in v2 – use GIF preview or open demo.html.');
    } else if (action === 'regen') {
      lastRun = await runConversion({ renderConfig: render });
    } else if (action === 'done') {
      done = true;
    }
  }
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
