/**
 * ASCII-fi – Terminal preview renderer.
 *
 * Plays an ASCII animation directly in the terminal using log-update.
 */

import logUpdate from 'log-update';
import { pickColorForChar, contrastColor, nearestPaletteColor } from './render.js';

/**
 * Play frames in the terminal.
 *
 * @param {object}  opts
 * @param {Array}   opts.frames – Array of frame objects ({ chars }).
 * @param {number}  opts.width  – Characters per row.
 * @param {number}  opts.height – Rows per frame.
 * @param {number}  opts.fps    – Playback frame rate.
 * @param {object}  opts.render  – Render config (mode, palette, theme).
 * @returns {Promise<void>} Resolves when playback completes (all frames shown once).
 */
export function previewInTerminal({ frames, width, height, fps, render }) {
	return new Promise((resolve) => {
		let idx = 0;
		const interval = 1000 / fps;

		const fg = parseHexColor(render?.theme?.fg, [0, 255, 0]);
		const bg = parseHexColor(render?.theme?.bg, [0, 0, 0]);
		const fgAnsi = `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
		const bgAnsi = `\x1b[48;2;${bg[0]};${bg[1]};${bg[2]}m`;
		const resetAnsi = '\x1b[0m';

		const timer = setInterval(() => {
			const frame = frames[idx];
			let output = '';

			for (let row = 0; row < height; row++) {
				const line = frame.chars.slice(row * width, (row + 1) * width);

				let coloredLine = '';
				for (let col = 0; col < line.length; col++) {
					const ci = row * width + col;
					const ch = line[col];
					if ((render?.mode === 'truecolor' || render?.mode === 'palette') && frame.colors && frame.colors[ci]) {
						let cellBg = frame.colors[ci];
						if (render?.mode === 'palette' && render?.palette?.length) {
							cellBg = nearestPaletteColor(cellBg, render.palette);
						}
						const cellFg = contrastColor(cellBg[0], cellBg[1], cellBg[2]);
						coloredLine += `\x1b[48;2;${cellBg[0]};${cellBg[1]};${cellBg[2]}m\x1b[38;2;${cellFg[0]};${cellFg[1]};${cellFg[2]}m${ch}${resetAnsi}`;
					} else {
						const rgb = pickColorForChar(ch, render, frame.colors ? frame.colors[ci] : null, fg);
						coloredLine += `${bgAnsi}\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m${ch}${resetAnsi}`;
					}
				}
				output += coloredLine + '\n';
			}

			logUpdate(output);
			idx++;

			if (idx >= frames.length) {
				clearInterval(timer);
				logUpdate.done();
				resolve();
			}
		}, interval);
	});
}

function parseHexColor(hex, fallback) {
	const m = /^#?([0-9a-fA-F]{6})$/.exec(hex || '');
	if (!m) return fallback;
	const n = parseInt(m[1], 16);
	return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
