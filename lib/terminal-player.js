/**
 * ASCII-fi – Node.js Terminal Player.
 *
 * Designed to decode compressed ASCII-fi bundle payloads
 * natively in Node.js using `node:zlib` and render them inline
 * to `process.stdout` using ANSI truecolor sequence escape codes.
 *
 * Yields time back to the Node event loop using async delays,
 * strictly drawing within exactly one allocated bounding box
 * using relative cursor movement to avoid clearing host terminal history.
 */

import { gunzipSync } from 'node:zlib';

function fromBase64(b64) {
	return Buffer.from(b64, 'base64');
}

// V4 encoding decoders
function _dv(b) {
	const s = Buffer.from(b, 'base64').toString('binary');
	const r = [];
	let i = 0;
	while (i < s.length) {
		let n = 0, h = 0, c;
		do {
			c = s.charCodeAt(i++);
			n |= (c & 127) << h;
			h += 7;
		} while (c >= 128);
		r.push(n);
	}
	return r;
}
function _ug(b) {
	const g = _dv(b), r = [];
	let p = 0;
	for (let i = 0; i < g.length; i++) {
		p += g[i];
		r.push(p);
	}
	return r;
}

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

export class TerminalPlayer {
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
		this._onSigint = this._handleSigint.bind(this);
	}

	static fromCompressed(b64) {
		try {
			const bin = fromBase64(b64);
			const decomp = gunzipSync(bin);

			const p = new TerminalPlayer();

			// Detect V5 Binary
			const magicArray = new Uint8Array(decomp.buffer, decomp.byteOffset, 7);
			const isV5 = (
				magicArray[0] === 6 && magicArray[1] === 65 && magicArray[2] === 83 &&
				magicArray[3] === 67 && magicArray[4] === 73 && magicArray[5] === 70 && magicArray[6] === 89
			);

			if (isV5) {
				p._initV5(decomp.buffer.slice(decomp.byteOffset, decomp.byteOffset + decomp.byteLength));
			} else {
				const jsonStr = new TextDecoder('utf-8').decode(decomp);
				const data = JSON.parse(jsonStr);
				p._initLegacy(data);
			}

			return p;
		} catch (err) {
			throw new Error(`Failed to decode animation bundle: ${err.message}`);
		}
	}

	_initV5(buf) {
		const r = new BinaryReader(buf);
		r.str(); // "ASCIFY"
		r.u8(); // version 5
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

				if (this.color) {
					if (r.u8() === 1) {
						const colorRleLen = r.vi();
						curCI = [];
						for (let i = 0; i < colorRleLen; i += 2) {
							const cn = r.vi();
							const cv = r.vi();
							for (let j = 0; j < cn; j++) curCI.push(cv);
						}
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

	_initLegacy(data) {
		this.width = data.width;
		this.height = data.height;
		this.fps = data.fps || 24;
		this.color = data.color || false;
		this.render = data.render || { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };

		if (data.v >= 4) {
			if (data.cd) {
				const h = data.cd, d = [];
				for (let i = 0; i < h.length; i += 6) {
					const v = parseInt(h.substr(i, 6), 16);
					d.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
				}
				this._colorDict = d;
			}
			this._decodeV4Frames(data.frames);
		} else if (data.v >= 2) {
			this._colorDict = data.colorDict || null;
			this._decodeV2Frames(data.frames);
		} else {
			this.frames = data.frames.map(f => this._decodeRLE(f.chars));
			this.colors = data.color ? data.frames.map(f => f.colors ? this._decodeColorRLE(f.colors) : null) : null;
		}
	}

	_decodeV4Frames(rawFrames) {
		const tc = this.width * this.height;
		this.colors = this.color ? [] : null;
		let prevC = ' '.repeat(tc);
		let prevCI = this.color ? new Array(tc).fill(0) : null;

		for (const f of rawFrames) {
			let curC, curCI;
			if (f.d === 1) {
				curC = prevC; curCI = prevCI;
			} else if (f.dp !== undefined) {
				const pos = _ug(f.dp);
				const a = prevC.split('');
				for (let i = 0; i < pos.length; i++) a[pos[i]] = f.dc[i];
				curC = a.join('');
				if (this.color && prevCI) {
					curCI = prevCI.slice();
					if (f.cp) {
						const cp = _ug(f.cp), cv = _dv(f.cv);
						for (let i = 0; i < cp.length; i++) curCI[cp[i]] = cv[i];
					}
				}
			} else {
				if (f.cn !== undefined) {
					const counts = _dv(f.cn);
					curC = '';
					for (let i = 0; i < counts.length; i++) curC += f.cc[i].repeat(counts[i]);
				} else {
					curC = this._decodeRLE(f.chars);
				}
				if (this.color) {
					if (f.ci && typeof f.ci === 'string') {
						const arr = _dv(f.ci); curCI = [];
						for (let i = 0; i < arr.length; i += 2) {
							for (let j = 0; j < arr[i]; j++) curCI.push(arr[i + 1]);
						}
					} else if (f.ci) {
						curCI = this._decodeIntRLE(f.ci);
					}
				}
			}
			this.frames.push(curC);
			if (this.colors) {
				if (curCI && this._colorDict) {
					this.colors.push(curCI.map(idx => this._colorDict[idx] || [0, 0, 0]));
				} else { this.colors.push(null); }
			}
			prevC = curC;
			if (curCI) prevCI = curCI;
		}
	}

	_decodeV2Frames(rawFrames) {
		const tc = this.width * this.height;
		this.colors = this.color ? [] : null;
		let prevC = ' '.repeat(tc);
		let prevCI = this.color ? new Array(tc).fill(0) : null;

		for (const f of rawFrames) {
			let curC, curCI;
			if (f.d === 1) {
				curC = prevC; curCI = prevCI;
			} else if (f.cd) {
				const a = prevC.split('');
				for (let i = 0; i < f.cd.length; i += 2) a[f.cd[i]] = f.cd[i + 1];
				curC = a.join('');
				if (this.color && prevCI) {
					curCI = prevCI.slice();
					if (f.cid) {
						for (let i = 0; i < f.cid.length; i += 2) curCI[f.cid[i]] = f.cid[i + 1];
					}
				}
			} else {
				curC = this._decodeRLE(f.chars);
				if (this.color && f.ci) { curCI = this._decodeIntRLE(f.ci); }
				else if (this.color && f.colors) {
					curCI = null;
					if (this.colors) {
						this.frames.push(curC);
						this.colors.push(f.colors ? this._decodeColorRLE(f.colors) : null);
						prevC = curC;
						continue;
					}
				}
			}
			this.frames.push(curC);
			if (this.colors) {
				if (curCI && this._colorDict) {
					this.colors.push(curCI.map(idx => this._colorDict[idx] || [0, 0, 0]));
				} else { this.colors.push(null); }
			}
			prevC = curC;
			if (curCI) prevCI = curCI;
		}
	}

	_decodeRLE(rle) {
		let o = '';
		for (let i = 0; i < rle.length; i += 2) o += rle[i + 1].repeat(rle[i]);
		return o;
	}
	_decodeIntRLE(rle) {
		const o = [];
		for (let i = 0; i < rle.length; i += 2) {
			for (let j = 0; j < rle[i]; j++) o.push(rle[i + 1]);
		}
		return o;
	}
	_decodeColorRLE(rle) {
		const o = [];
		for (let i = 0; i < rle.length; i += 2) {
			for (let j = 0; j < rle[i]; j++) o.push(rle[i + 1]);
		}
		return o;
	}

	_allocateSpace() {
		if (this._spaceAllocated) return;
		for (let i = 0; i < this.height; i++) {
			process.stdout.write('\n');
		}
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
		// Move cursor UP by this.height rows, securely placing us at the top left of our block
		out += `\x1b[${this.height}A\x1b[1G`;

		const mode = this.render?.mode || 'truecolor';
		const theme = this.render?.theme || {};

		if (mode === 'mono') {
			const fg = this._hexToRgb(theme.fg || '#0f0');
			out += `\x1b[38;2;${fg[0]};${fg[1]};${fg[2]}m`;
			for (let row = 0; row < this.height; row++) {
				out += chars.slice(row * this.width, (row + 1) * this.width);
				if (row < this.height - 1) out += '\n';
			}
			out += '\x1b[0m'; // Reset colors
			process.stdout.write(out);
			return;
		}

		const colorData = (this.color && this.colors) ? this.colors[idx] : null;
		let lastColor = null;

		for (let row = 0; row < this.height; row++) {
			for (let col = 0; col < this.width; col++) {
				const i = row * this.width + col;
				const ch = chars[i] || ' ';
				const cellColor = (ch !== ' ' && colorData && colorData[i]) ? colorData[i] : null;

				if (cellColor) {
					if (!lastColor || cellColor[0] !== lastColor[0] || cellColor[1] !== lastColor[1] || cellColor[2] !== lastColor[2]) {
						out += `\x1b[38;2;${Math.round(cellColor[0])};${Math.round(cellColor[1])};${Math.round(cellColor[2])}m`;
						lastColor = cellColor;
					}
				} else if (lastColor) {
					out += '\x1b[39m'; // Reset FG
					lastColor = null;
				}
				out += ch;
			}
			if (row < this.height - 1) out += '\n';
		}

		out += '\x1b[0m'; // Reset entirely
		process.stdout.write(out);
	}

	_handleSigint() {
		this.clear();
		process.exit(0);
	}

	play() {
		if (this._playing) return;
		this._playing = true;

		// Allocate visual lines on play
		this._allocateSpace();

		// Hide cursor
		process.stdout.write('\x1b[?25l');

		process.on('SIGINT', this._onSigint);

		const _loop = async () => {
			if (!this._playing) return;

			const startTime = performance.now();
			this._renderFrame(this._frameIndex);
			this._frameIndex = (this._frameIndex + 1) % this.frames.length;

			const frameDurationMs = 1000 / this.fps;
			const elapsed = performance.now() - startTime;
			const delay = Math.max(0, frameDurationMs - elapsed);

			this._timer = setTimeout(_loop, delay);
		};

		_loop();
	}

	pause() {
		if (!this._playing) return;
		this._playing = false;
		if (this._timer) {
			clearTimeout(this._timer);
			this._timer = null;
		}
	}

	stop() {
		this.pause();
		this._frameIndex = 0;
		// Reshow cursor
		process.stdout.write('\x1b[?25h');
		process.removeListener('SIGINT', this._onSigint);
	}

	clear() {
		this.stop();
		// Restore terminal if we had drawn frames
		if (this._spaceAllocated) {
			// Wipe exactly the region we drew
			process.stdout.write(`\x1b[${this.height}A\x1b[0J`);
			this._spaceAllocated = false;
		}
	}
}
