import test from 'node:test';
import assert from 'node:assert';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';

const execAsync = promisify(exec);
const CLI_PATH = path.join(process.cwd(), 'index.js');

test('CLI wrapper integrations', async (t) => {
	await t.test('exits > 0 when passed a non-existent file in fast mode', async () => {
		try {
			await execAsync(`node "${CLI_PATH}" invalid_fake_path.webm`);
			assert.fail('Should have failed with non-existent file path');
		} catch (err) {
			assert.ok(err.code > 0, 'Exit code > 0 for invalid file');
		}
	});

	await t.test('exits 0 for help flag', async () => {
		const { stdout } = await execAsync(`node "${CLI_PATH}" --help`);
		assert.ok(stdout.includes('Usage:'), 'Should print help text');
	});
});
