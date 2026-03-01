#!/usr/bin/env node

/**
 * ASCII-fi Terminal Player (Standalone)
 *
 * Usage: node ascii-player.js <bundle.js>
 *
 * Designed for high-performance terminal playback of ASCII-fi bundles.
 * Uses ANSI truecolor sequences and relative cursor movement.
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';

class BinaryReader {
	constructor(buf) {
		this.v = new Uint8Array(buf);
		this.p = 0;
	}
	u8() { return this.v[this.p++]; }
	u16() {
		const val = this.v[this.p] | (this.v[this.p + 1] << 8);
		this.p += 2;
		return val;
	}
	vi() {
		let r = 0, s = 0, c;
		do {
			c = this.v[this.p++];
			r |= (c & 127) << s;
			s += 7;
		} while (c >= 128);
		return r;
	}
	str() {
		const l = this.vi();
		const s = new TextDecoder('utf-8').decode(this.v.subarray(this.p, this.p + l));
		this.p += l;
		return s;
	}
}

class TerminalPlayer {
	constructor() {
		this.width = 0;
		this.height = 0;
		this.fps = 24;
		this.color = false;
		this.render = { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };
		this._colorDict = null;
		this.frames = [];
		this.colors = null;

		this._frameIndex = 0;
		this._timer = null;
		this._playing = false;
		this._spaceAllocated = false;

		// Use proper binding for event listeners
		this._onSigint = () => {
			this.clear();
			process.exit(0);
		};
	}

	static fromCompressed(b64) {
		const bin = Buffer.from(b64, 'base64');
		const decomp = gunzipSync(bin);
		const p = new TerminalPlayer();

		const magicArray = new Uint8Array(decomp.buffer, decomp.byteOffset, 7);
		const isV5 = (
			magicArray[0] === 6 && magicArray[1] === 65 && magicArray[2] === 83 &&
			magicArray[3] === 67 && magicArray[4] === 73 && magicArray[5] === 70 && magicArray[6] === 89
		);

		if (isV5) {
			p._initV5(decomp.buffer.slice(decomp.byteOffset, decomp.byteOffset + decomp.byteLength));
		} else {
			// Basic support for older JSON/Gzip formats if encountered
			try {
				const json = JSON.parse(new TextDecoder().decode(decomp));
				p.width = json.width;
				p.height = json.height;
				p.fps = json.fps || 24;
				p.frames = json.frames.map(f => f.chars || ''); // Simplified
			} catch (e) {
				throw new Error('Unsupported or corrupted bundle format.');
			}
		}
		return p;
	}

	_initV5(buf) {
		const r = new BinaryReader(buf);
		r.str(); // "ASCIFY"
		r.u8();  // version
		this.width = r.u16();
		this.height = r.u16();
		this.fps = r.u8();
		this.color = r.u8() === 1;
		this.render = {
			mode: r.str(),
			theme: { fg: r.str(), bg: r.str() }
		};

		const dictLen = r.vi();
		if (this.color && dictLen > 0) {
			this._colorDict = [];
			for (let i = 0; i < dictLen; i++) {
				this._colorDict.push([r.u8(), r.u8(), r.u8()]);
			}
		}

		const nFrames = r.vi();
		const tc = this.width * this.height;
		let prevC = ' '.repeat(tc);
		let prevCI = this.color ? new Array(tc).fill(0) : null;
		this.colors = this.color ? [] : null;

		for (let fi = 0; fi < nFrames; fi++) {
			const type = r.u8();
			let curC = '', curCI = null;

			if (type === 0) {
				curC = prevC;
				curCI = prevCI;
			} else if (type === 1) {
				const countsLen = r.vi();
				const counts = new Array(countsLen);
				for (let i = 0; i < countsLen; i++) counts[i] = r.vi();
				const charsStr = r.str();
				for (let i = 0; i < countsLen; i++) curC += charsStr[i].repeat(counts[i]);

				if (this.color && r.u8() === 1) {
					const colorRleLen = r.vi();
					curCI = [];
					for (let i = 0; i < colorRleLen; i += 2) {
						const cn = r.vi(); const cv = r.vi();
						for (let j = 0; j < cn; j++) curCI.push(cv);
					}
				}
			} else if (type === 2) {
				const gapsLen = r.vi();
				const pos = new Array(gapsLen);
				let p = 0;
				for (let i = 0; i < gapsLen; i++) { p += r.vi(); pos[i] = p; }
				const charsStr = r.str();
				const a = prevC.split('');
				for (let i = 0; i < gapsLen; i++) a[pos[i]] = charsStr[i];
				curC = a.join('');

				if (this.color && prevCI) {
					curCI = prevCI.slice();
					if (r.u8() === 1) {
						const cgLen = r.vi();
						const cp = new Array(cgLen);
						let cpv = 0;
						for (let i = 0; i < cgLen; i++) { cpv += r.vi(); cp[i] = cpv; }
						for (let i = 0; i < cgLen; i++) curCI[cp[i]] = r.vi();
					}
				}
			}

			this.frames.push(curC);
			if (this.colors) {
				if (curCI && this._colorDict) {
					this.colors.push(curCI.map(idx => this._colorDict[idx] || [0, 0, 0]));
				} else {
					this.colors.push(null);
				}
			}
			prevC = curC;
			if (curCI) prevCI = curCI;
		}
	}

	_allocateSpace() {
		if (this._spaceAllocated) return;
		// Print N lines to ensure we have a bounding box to overwrite
		for (let i = 0; i < this.height; i++) process.stdout.write('\n');
		this._spaceAllocated = true;
	}

	_hexToRgb(hex) {
		const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '#ffffff');
		return result ? [
			parseInt(result[1], 16),
			parseInt(result[2], 16),
			parseInt(result[3], 16)
		] : [255, 255, 255];
	}

	_renderFrame(idx) {
		const chars = this.frames[idx];
		if (!chars) return;

		let out = '';

		const mode = this.render?.mode || 'truecolor';
		const theme = this.render?.theme || {};

		if (mode === 'mono') {
			const fg = this._hexToRgb(theme.fg || '#0f0');
			out += `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
			for (let row = 0; row < this.height; row++) {
				out += chars.slice(row * this.width, (row + 1) * this.width);
				if (row < this.height - 1) out += '\n';
			}
			out += '\x1b[0m';
			process.stdout.write(out);
			return;
		}

		const colorData = (this.color && this.colors) ? this.colors[idx] : null;
		let lastColor = null;

		for (let row = 0; row < this.height; row++) {
			let rowText = '';
			for (let col = 0; col < this.width; col++) {
				const i = row * this.width + col;
				const ch = chars[i] || ' ';
				const cellColor = (colorData && colorData[i]) ? colorData[i] : null;

				if (cellColor) {
					if (!lastColor || cellColor[0] !== lastColor[0] || cellColor[1] !== lastColor[1] || cellColor[2] !== lastColor[2]) {
						rowText += `\x1b[38;2;${Math.round(cellColor[0])};${Math.round(cellColor[1])};${Math.round(cellColor[2])}m`;
						lastColor = cellColor;
					}
				} else if (lastColor) {
					rowText += '\x1b[39m';
					lastColor = null;
				}
				rowText += ch;
			}
			out += rowText;
			if (row < this.height - 1) out += '\n';
		}

		out += '\x1b[0m';
		process.stdout.write(out);
	}

	play() {
		if (this._playing) return;
		this._playing = true;

		this._allocateSpace();
		// Hide cursor and save position
		process.stdout.write('\x1b[?25l\x1b[u');

		process.on('SIGINT', this._onSigint);

		const _loop = () => {
			if (!this._playing) return;

			const start = performance.now();

			// Move back to the saved start position
			process.stdout.write('\x1b[u');
			this._renderFrame(this._frameIndex);
			this._frameIndex = (this._frameIndex + 1) % this.frames.length;

			const elapsed = performance.now() - start;
			const delay = Math.max(0, (1000 / this.fps) - elapsed);
			this._timer = setTimeout(_loop, delay);
		};

		// Initial save: move up from where we are (post-allocation) to the top of our box and save
		process.stdout.write(`\x1b[${this.height}A\x1b[s`);
		_loop();
	}

	stop() {
		this._playing = false;
		if (this._timer) clearTimeout(this._timer);
		process.stdout.write('\x1b[?25h'); // Reshow cursor
		process.removeListener('SIGINT', this._onSigint);
	}

	clear() {
		this.stop();
		if (this._spaceAllocated) {
			// Wipe the area we occupied
			process.stdout.write(`\x1b[${this.height}A\x1b[0J`);
			this._spaceAllocated = false;
		}
	}
}

async function main() {
	const bundlePath = process.argv[2];
	if (!bundlePath) {
		console.log('Usage: node scripts/ascii-player.js <bundle.js>');
		process.exit(1);
	}

	try {
		const fullPath = path.resolve(bundlePath);
		const content = await fs.readFile(fullPath, 'utf8');
		const match = content.match(/__ASCII_COMPRESSED__="([^"]+)"/);
		if (!match) throw new Error('Could not find compressed payload in file.');

		const player = TerminalPlayer.fromCompressed(match[1]);

		console.log(`\nPlaying: ${path.basename(fullPath)} (${player.width}x${player.height} @ ${player.fps}fps)`);
		console.log(`Frames: ${player.frames.length} | Colors: ${player.color ? 'Enabled' : 'Disabled'}`);
		console.log('Press Ctrl+C to stop.\n');

		player.play();
	} catch (err) {
		console.error(`Error: ${err.message}`);
		process.exit(1);
	}
}

main();
