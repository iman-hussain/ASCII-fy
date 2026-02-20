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
import { resolve, extname, join } from 'node:path';
import { spawn } from 'node:child_process';
import inquirer from 'inquirer';
import ora from 'ora';
import cliProgress from 'cli-progress';
import { generateBundle, hexToRgbArray } from './lib/api.js';
import { probeVideo } from './lib/converter.js';

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

function validateHexColor(val) {
	return /^#?[0-9a-fA-F]{6}$/.test(val) || 'Use hex format like #00ff00.';
}

function ensureHexOrFallback(val, fallback) {
	return /^#?[0-9a-fA-F]{6}$/.test(val || '') ? val : fallback;
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

function parseCliArgs(argv) {
	const args = argv.slice(2);
	const opts = {
		inputFile: null, width: null, fps: null, mode: null, depth: null,
		palette: null, fg: null, bg: null, start: null, end: null, charMode: null,
		noGif: false, noOpen: false, help: false,
	};

	for (let i = 0; i < args.length; i++) {
		const a = args[i];
		const next = () => args[++i];

		if (a === '-h' || a === '--help') { opts.help = true; }
		else if (a === '-w' || a === '--width') { opts.width = Number(next()); }
		else if (a === '-f' || a === '--fps') { opts.fps = Number(next()); }
		else if (a === '-m' || a === '--mode') { opts.mode = next(); }
		else if (a === '-d' || a === '--depth') { opts.depth = Number(next()); }
		else if (a === '-p' || a === '--palette') { opts.palette = next(); }
		else if (a === '--fg') { opts.fg = next(); }
		else if (a === '--bg') { opts.bg = next(); }
		else if (a === '-s' || a === '--start') { opts.start = Number(next()); }
		else if (a === '-e' || a === '--end') { opts.end = Number(next()); }
		else if (a === '-g' || a === '--char-mode') { opts.charMode = next(); }
		else if (a === '--brightness') { opts.customBrightness = parseInt(next()); }
		else if (a === '--contrast') { opts.customContrast = parseInt(next()); }
		else if (a === '--no-gif') { opts.noGif = true; }
		else if (a === '--no-open') { opts.noOpen = true; }
		else if (!a.startsWith('-') && !opts.inputFile) {
			opts.inputFile = a;
		}
	}

	// Support for custom tone via CLI flags
	if (typeof opts.customBrightness === 'number' || typeof opts.customContrast === 'number') {
		opts.customTone = {
			brightness: opts.customBrightness || 0,
			contrast: opts.customContrast || 0
		};
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
        --brightness <int>  Manual brightness override (-100 to 100)
        --contrast <int>    Manual contrast override (-100 to 100)
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

function makeCallbacks(noOpen) {
	let spinner = null;
	let bar = null;

	return {
		onStart: ({ phase, message, expectedFrames }) => {
			if (spinner) {
				spinner.stop();
				spinner = null;
			}
			if (phase === 'conversion' && expectedFrames) {
				bar = new cliProgress.SingleBar({
					format: 'Converting |{bar}| {percentage}% | {value}/{total} frames | ETA: {eta}s',
					hideCursor: true,
				}, cliProgress.Presets.shades_classic);
				bar.start(expectedFrames, 0);
			} else {
				spinner = ora(message).start();
			}
		},
		onProgress: ({ phase, frameCount, expectedFrames }) => {
			if (phase === 'conversion') {
				if (bar) {
					bar.update(Math.min(frameCount, expectedFrames || frameCount));
				} else if (spinner) {
					spinner.text = `Converting… frame ${frameCount}`;
				}
			}
		},
		onSuccess: ({ phase, message, bundleInfo, gifPath }) => {
			if (phase === 'conversion' && bar) {
				bar.stop();
				bar = null;
			}
			if (spinner) {
				spinner.succeed(message);
				spinner = null;
			}

			if (phase === 'gif' && gifPath) {
				console.log(`\n  📄  ${gifPath}`);
				if (!noOpen) openFileDefault(gifPath);
			}
			if (phase === 'bundle' && bundleInfo) {
				console.log(`\n  📄  ${bundleInfo.bundlePath}`);
				console.log(`  📄  ${bundleInfo.htmlPath}`);
			}
		},
		onFail: ({ phase, message }) => {
			if (bar) {
				bar.stop();
				bar = null;
			}
			if (spinner) {
				spinner.fail(message);
				spinner = null;
			}
		}
	};
}

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

	const callbacks = makeCallbacks(cli.noOpen);

	try {
		const result = await generateBundle({
			inputFile: inputPath,
			outDir: outputDir,
			width: cli.width || 100,
			fps: cli.fps || 24,
			mode: cli.mode || 'truecolor',
			depth: cli.depth || 16,
			palette: cli.palette || 'realistic',
			fg: cli.fg || '#00ff00',
			bg: cli.bg || '#000000',
			start: cli.start ?? undefined,
			end: cli.end ?? undefined,
			charMode: cli.charMode === 'block' ? 'block' : 'ascii',
			skipGif: cli.noGif
		}, callbacks);

		if (result.bundlePath) {
			console.log(`  🎨  ${result.render.label}`);
			console.log(`  📊  ${result.frameCount} frames | Bundle: ${formatBytes(result.stats.bundleSize)} | Gzip: ${result.stats.gzipRatio}\n`);
		}

	} catch (err) {
		process.exit(1);
	}
}

async function runInteractive() {
	const cwd = process.cwd();
	const { inputDir: defaultInputDir, outputDir: defaultOutputDir } = await ensureIoDirs(cwd);

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
	]);

	const inputPath = answers.customPath || answers.inputFile;
	const outputWidth = answers.outputWidth;
	const outputFps = answers.outputFps;
	let charMode = answers.charMode || 'ascii';

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

	let renderOpts = {
		mode: 'truecolor'
	};

	const runConversion = async () => {
		const callbacks = makeCallbacks(false);
		try {
			const result = await generateBundle({
				inputFile: inputPath,
				outDir: defaultOutputDir,
				width: outputWidth,
				fps: outputFps,
				start: startTime,
				end: endTime,
				charMode: charMode,
				skipGif: false,
				...renderOpts
			}, callbacks);

			if (result.bundlePath) {
				console.log(`  🎨  ${result.render.label}`);
				console.log(`  📊  ${result.frameCount} frames | Bundle: ${formatBytes(result.stats.bundleSize)} | Gzip: ${result.stats.gzipRatio}\n`);
			}
			return result;
		} catch (err) {
			return null;
		}
	};

	let lastRun = await runConversion();

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
					{ name: `Char mode: ${charMode === 'block' ? 'block (█▓▒░)' : 'ascii (edges)'} (toggle)`, value: 'toggle-char-mode' },
					{ name: 'Open GIF preview', value: 'open-gif' },
					{ name: 'Preview in terminal', value: 'preview' },
					{ name: 'Regenerate bundle + GIF', value: 'regen' },
					{ name: 'Finish', value: 'done' },
				],
			},
		]);

		if (action === 'truecolor') {
			renderOpts = { mode: 'truecolor' };
			lastRun = await runConversion();
		} else if (action === 'toggle-char-mode') {
			charMode = charMode === 'block' ? 'ascii' : 'block';
			console.log(`  Char mode set to: ${charMode}`);
			lastRun = await runConversion();
		} else if (action === 'mono') {
			const prevTheme = lastRun && lastRun.render && lastRun.render.theme ? lastRun.render.theme : {};
			const colorAnswers = await inquirer.prompt([
				{
					type: 'input',
					name: 'fg',
					message: 'Foreground color (hex):',
					default: ensureHexOrFallback(prevTheme.fg, '#00ff00'),
					validate: validateHexColor,
				},
				{
					type: 'input',
					name: 'bg',
					message: 'Background color (hex):',
					default: ensureHexOrFallback(prevTheme.bg, '#000000'),
					validate: validateHexColor,
				},
			]);
			renderOpts = { mode: 'mono', fg: colorAnswers.fg, bg: colorAnswers.bg };
			lastRun = await runConversion();
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

			const colorCount = depthAnswers.depth;

			if (paletteAnswers.palette === 'custom') {
				const custom = await inquirer.prompt([
					{ type: 'input', name: 'c1', message: 'Palette color 1 (hex):', default: '#2c3e50', validate: validateHexColor },
					{ type: 'input', name: 'c2', message: 'Palette color 2 (hex):', default: '#95a5a6', validate: validateHexColor },
					{ type: 'input', name: 'c3', message: 'Palette color 3 (hex):', default: '#f1c40f', validate: validateHexColor },
				]);
				const customPaletteArray = [
					hexToRgbArray(custom.c1, [44, 62, 80]),
					hexToRgbArray(custom.c2, [149, 165, 166]),
					hexToRgbArray(custom.c3, [241, 196, 15]),
				];
				renderOpts = { mode: 'palette', depth: colorCount, customPalette: customPaletteArray };
			} else {
				renderOpts = { mode: 'palette', depth: colorCount, palette: paletteAnswers.palette };
			}
			lastRun = await runConversion();
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
			renderOpts = { mode: 'kmeans', depth: depthAnswers.depth };
			lastRun = await runConversion();
		} else if (action === 'open-gif') {
			if (lastRun && lastRun.gifPath) {
				openFileDefault(lastRun.gifPath);
			} else {
				console.log('  ⚠  No GIF available. Run a conversion first.');
			}
		} else if (action === 'preview') {
			console.log('  ⚠  Terminal preview removed in v2 – use GIF preview or open demo.html.');
		} else if (action === 'regen') {
			lastRun = await runConversion();
		} else if (action === 'done') {
			done = true;
		}
	}
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

main().catch((err) => {
	console.error('Fatal error:', err.message);
	process.exit(1);
});
