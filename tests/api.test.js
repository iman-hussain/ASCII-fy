import test from 'node:test';
import assert from 'node:assert';
import { generateBundle } from '../lib/api.js';
import fs from 'node:fs/promises';
import path from 'node:path';

const DUMMY_VIDEO = path.join(process.cwd(), 'tests', 'dummy.mp4');
const TEST_OUT_DIR = path.join(process.cwd(), 'tests', 'output_dummy');

test('generateBundle Core API', async (t) => {
	await t.test('throws TypeError on missing input parameters', async () => {
		await assert.rejects(
			async () => await generateBundle({}),
			TypeError
		);
	});

	await t.test('successfully generates valid bundle payload from video', async () => {
		// Generate valid ascii structure using dummy 10x10 ultra-fast test source
		const result = await generateBundle({
			inputFile: DUMMY_VIDEO,
			outDir: TEST_OUT_DIR,
			width: 10,
			fps: 10,
			mode: 'truecolor',
			skipGif: true
		});

		assert.ok(result, 'Result object returned successfully');
		assert.ok(result.bundlePath, 'Bundle Path explicitly defined');
		assert.strictEqual(result.frameCount, 10, 'Expected exactly 10 frames from 1sec 10fps dummy data');

		// Evaluate bundle structure
		try {
			const bundleSource = await fs.readFile(result.bundlePath, 'utf8');
			assert.ok(bundleSource.includes('class AsciiPlayer'), 'Should contain the AsciiPlayer payload instance');
			assert.ok(bundleSource.includes('__ASCII_COMPRESSED__'), 'Should inherently contain the Delta RLE payload constant');
		} catch {
			assert.fail('The bundle.js file was missing entirely');
		}

		// Evaluate HTML structure
		try {
			const htmlSource = await fs.readFile(result.htmlPath, 'utf8');
			assert.ok(htmlSource.includes('<script src="bundle.js"></script>'), 'Should inherently include the external bundle script tag');
		} catch {
			assert.fail('The demo.html index file was missing entirely');
		}
	});

	// Cleanup testing directory after hook execution finishes
	t.after(async () => {
		await fs.rm(TEST_OUT_DIR, { recursive: true, force: true }).catch(() => { });
	});
});
