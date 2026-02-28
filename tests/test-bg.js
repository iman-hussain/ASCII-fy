import { generateBundle } from './lib/api.js';
import { readFileSync } from 'node:fs';

async function testBg() {
	console.log('Testing background color rendering...');
	const out = await generateBundle({
		inputFile: './tests/corgi.webm',
		outDir: './output',
		width: 40,
		fps: 10,
		end: 1,
		mode: 'truecolor',
		bg: '#ff00ff', // Magenta background
		detail: 50 // To force some spaces
	});
	console.log('Generated:', out.htmlPath);
}

testBg().catch(console.error);
