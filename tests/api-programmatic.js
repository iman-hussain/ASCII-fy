import fs from 'node:fs/promises';
import { generateBundle, TerminalPlayer } from '../lib/api.js';

async function main() {
	console.log('Testing programmatic API and TerminalPlayer...');

	try {
		const result = await generateBundle({
			inputFile: 'input/corgi.webm',
			width: 60,
			fps: 12,
			mode: 'truecolor',
			skipGif: true
		});

		console.log('API call succeeded! Loading TerminalPlayer...');

		// Read the generated bundle from output
		const bundleJs = await fs.readFile(result.bundlePath, 'utf8');

		// Extract base64 out of bundle.js
		const match = bundleJs.match(/__ASCII_COMPRESSED__="([^"]+)"/);
		if (!match) throw new Error('Could not extract compresssed string');

		const player = TerminalPlayer.fromCompressed(match[1]);

		console.log('Playing terminal animation inline for 3 seconds...\n');
		player.play();

		// Async block the script without freezing the event loop
		await new Promise(r => setTimeout(r, 3000));

		player.stop();
		console.log('Playback finished.');
	} catch (err) {
		console.error('API call failed:', err);
	}
}

main();
