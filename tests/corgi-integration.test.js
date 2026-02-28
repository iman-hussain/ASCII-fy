import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { generateBundle } from '../lib/api.js';

async function runIntegrationTest() {
	console.log('--- Corgi Integration Test ---');

	const inputDir = 'input';
	const inputFile = path.join(inputDir, 'corgi.webm');
	const outputDir = 'output/integration-test';

	// Download test file if running in CI or on a fresh clone
	if (!fs.existsSync(inputFile)) {
		console.log(`0. Test file not found at ${inputFile}, downloading fallback...`);
		if (!fs.existsSync(inputDir)) fs.mkdirSync(inputDir, { recursive: true });

		try {
			// Download a tiny dummy mp4 from the tests directory (or a public URL if preferred)
			const res = await fetch('https://raw.githubusercontent.com/mathiasbynens/small/master/cat.mp4');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const buffer = await res.arrayBuffer();
			fs.writeFileSync(inputFile, Buffer.from(buffer));
			console.log(`✅ Downloaded fallback test file.`);
		} catch (e) {
			console.warn(`[WARN] Skipping integration test. Could not download test file: ${e.message}`);
			process.exit(0);
		}
	}

	console.log(`1. Compressing ${inputFile}...`);
	try {
		const result = await generateBundle({
			inputFile,
			outDir: outputDir,
			width: 40,
			fps: 24,
			mode: 'truecolor',
			skipGif: true
		});

		console.log(`✅ Compression succeeded: ${result.bundlePath}`);

		console.log('2. Verifying standalone playback via scripts/ascii-player.js...');

		// 2a. Headless verification (detect ANSI)
		const verifyProcess = spawn('node', ['scripts/ascii-player.js', result.bundlePath], {
			stdio: 'pipe'
		});

		let outputReceived = false;
		verifyProcess.stdout.on('data', (data) => {
			if (data.toString().includes('\x1b[')) outputReceived = true;
		});

		await new Promise((resolve) => {
			setTimeout(() => {
				verifyProcess.kill('SIGINT');
				resolve();
			}, 2000);
		});

		if (!outputReceived) {
			console.error('❌ Standalone verification failed: No animation output detected.');
			process.exit(1);
		}
		console.log('✅ Standalone verification passed.');

		// 3. Interactive Playback (Show the user!)
		console.log('\n3. Starting interactive playback for 5 seconds (watch the corgi!)\n');

		const playerProcess = spawn('node', ['scripts/ascii-player.js', result.bundlePath], {
			stdio: 'inherit'
		});

		await new Promise((resolve) => {
			setTimeout(() => {
				playerProcess.kill('SIGINT');
				console.log('\n✅ Integration test complete. You saw the corgi!');
				process.exit(0);
			}, 5000);
		});

	} catch (err) {
		console.error('❌ Integration test failed during compression:', err.message);
		process.exit(1);
	}
}

runIntegrationTest();
