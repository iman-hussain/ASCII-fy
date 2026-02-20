import test from 'node:test';
import assert from 'node:assert';
import { TerminalPlayer } from '../lib/terminal-player.js';

test('TerminalPlayer logic assertions', async (t) => {
	// Mock process.stdout to prevent tests clobbering the terminal output
	const originalWrite = process.stdout.write;
	let stdoutOutput = '';
	process.stdout.write = (str) => {
		stdoutOutput += str;
		return true;
	};

	try {
		const player = new TerminalPlayer();

		await t.test('starts unmounted with 0 initialized defaults', () => {
			assert.strictEqual(player.width, 0);
			assert.strictEqual(player.height, 0);
			assert.strictEqual(player.fps, 24);
			assert.strictEqual(player._playing, false);
			assert.strictEqual(player._spaceAllocated, false);
		});

		await t.test('handles play/pause seamlessly traversing play state', () => {
			player.play();
			assert.strictEqual(player._playing, true);
			player.pause();
			assert.strictEqual(player._playing, false);
		});

		await t.test('handles stop correctly clearing interval loops', () => {
			player.stop();
			assert.strictEqual(player._frameIndex, 0, 'Frame Index should reset strictly to 0 upon executing stop()');
			assert.strictEqual(player._playing, false, 'Playing tracker should revert firmly to false.');
		});

		await t.test('handles clear correctly removing terminal spaces', () => {
			player.clear();
			assert.strictEqual(player._spaceAllocated, false, 'Internal tracking allocated line counter evaluates to zero explicitly resetting padding');
		});

		await t.test('TerminalPlayer.fromCompressed() static parser resolves mock data accurately', async () => {
			// Mock tiny raw uncompressed bundle logic specifically encoding Version 5 Zlib metadata
			const DUMMY_FRAME_MOCK_PAYLOAD = "H4sIAAAAAAAAAwEDAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" + "AAAAAA"; // A severely partial placeholder solely evaluating execution boundary intercepts safely throwing buffer errors versus catastrophic generic fallthroughs.

			try {
				TerminalPlayer.fromCompressed(DUMMY_FRAME_MOCK_PAYLOAD);
				assert.fail('Since data is severely malformed, parsing should fail');
			} catch (err) {
				assert.ok(err.message.includes("invalid stored block lengths") || err.message.toLowerCase().includes("incorrect header check") || err.message.toLowerCase().includes("invalid file signature"), 'Internal Node Zlib safely catches buffer decompressions exceptions gracefully without killing the event loop.');
			}
		});

	} finally {
		// Restore stdout
		process.stdout.write = originalWrite;
	}
});
