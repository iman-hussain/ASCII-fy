/**
 * ascii-fy – Client-side AsciiPlayer class (v4).
 *
 * Embedded directly into the generated bundle.js.
 * Handles:
 *   - Native gzip decompression via DecompressionStream (zero deps)
 *   - V5: pure binary custom format for maximum compression density
 *   - V2/V3/V4 backward compat: JSON-array and varint packed
 *   - Rendering to DOM via <pre> with per-cell <span> colouring.
 *
 * NOTE: This is a **template string** inlined into the bundle.
 *       Must be valid standalone browser JS (no imports / no template literals).
 */

const PLAYER_SOURCE = `
/* Varint (LEB128) decoder: base64 → array of unsigned ints */
function _dv(b){var s=atob(b),r=[],i=0;while(i<s.length){var n=0,h=0,c;do{c=s.charCodeAt(i++);n|=(c&127)<<h;h+=7}while(c>=128);r.push(n)}return r}
/* Gap decoder: base64 varint gaps → absolute positions */
function _ug(b){var g=_dv(b),r=[],p=0;for(var i=0;i<g.length;i++){p+=g[i];r.push(p)}return r}

/* V5 Binary Reader */
class _BR {
  constructor(buf) { this.v = new Uint8Array(buf); this.p = 0; }
  u8() { return this.v[this.p++]; }
  u16() { var v = this.v[this.p] | (this.v[this.p+1]<<8); this.p+=2; return v; }
  vi() { var r=0, s=0, c; do { c=this.v[this.p++]; r|=(c&127)<<s; s+=7; } while(c>=128); return r; }
  str() {
    var l = this.vi();
    var s = '';
    // simple utf-8 decode, avoiding TextDecoder for compat/size if preferred, but TextDecoder is small
    // Actually TextDecoder is standard, but some older browsers might struggle.
    // Let's use TextDecoder since we already use DecompressionStream.
    s = new TextDecoder('utf-8').decode(this.v.subarray(this.p, this.p+l));
    this.p+=l; return s;
  }
}


class AsciiPlayer {
  constructor(data) { this._init(data); }

  static async fromCompressed(b64) {
    var bin = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    var ds = new DecompressionStream('gzip');
    var stream = new Blob([bin]).stream().pipeThrough(ds);
    var buf = await new Response(stream).arrayBuffer();

    // Check if it's V5 binary format
    var magicArray = new Uint8Array(buf, 0, 7);
    var isV5 = (magicArray[0] === 6 && magicArray[1] === 65 && magicArray[2] === 83 && magicArray[3] === 67 && magicArray[4] === 73 && magicArray[5] === 70 && magicArray[6] === 89);

    var p = new AsciiPlayer.__empty();
    if (isV5) {
      p._initV5(buf);
    } else {
      var data = JSON.parse(new TextDecoder('utf-8').decode(buf));
      p._init(data);
    }
    return p;
  }

  _init(data) {
    this.width  = data.width;
    this.height = data.height;
    this.fps    = data.fps || 24;
    this.color  = data.color || false;
    this.render = data.render || { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };
    this._colorDict = null;

    if (data.v >= 4) {
      /* V4: hex-encoded colour dictionary */
      if (data.cd) {
        var h = data.cd, d = [];
        for (var i = 0; i < h.length; i += 6) {
          var v = parseInt(h.substr(i, 6), 16);
          d.push([(v >> 16) & 255, (v >> 8) & 255, v & 255]);
        }
        this._colorDict = d;
      }
      this._decodeV4Frames(data.frames);
    } else if (data.v >= 2) {
      this._colorDict = data.colorDict || null;
      this._decodeV2Frames(data.frames);
    } else {
      this.frames = data.frames.map(function(f) { return this._decodeRLE(f.chars); }.bind(this));
      this.colors = data.color
        ? data.frames.map(function(f) { return f.colors ? this._decodeColorRLE(f.colors) : null; }.bind(this))
        : null;
    }

    this._frameIndex = 0;
    this._timer = null;
    this._pre = null;
    this._el = null;
  }

  /* ── V5 Binary decoder ── */
  _initV5(buf) {
    var r = new _BR(buf);
    r.str(); // "ASCIFY"
    var v = r.u8(); // version = 5
    this.width = r.u16();
    this.height = r.u16();
    this.fps = r.u8();
    this.color = r.u8() === 1;
    this.render = {
      mode: r.str(),
      theme: { fg: r.str(), bg: r.str() }
    };

    this._colorDict = null;
    var dictLen = r.vi();
    if (this.color && dictLen > 0) {
      this._colorDict = [];
      for (var i = 0; i < dictLen; i++) {
        this._colorDict.push([r.u8(), r.u8(), r.u8()]);
      }
    }

    var nFrames = r.vi();
    var tc = this.width * this.height;
    this.frames = [];
    this.colors = this.color ? [] : null;
    var prevC = ' '.repeat(tc);
    var prevCI = this.color ? new Array(tc).fill(0) : null;

    for (var fi = 0; fi < nFrames; fi++) {
      var type = r.u8();
      var curC, curCI;

      if (type === 0) {
        /* Duplicate */
        curC = prevC; curCI = prevCI;
      } else if (type === 1) {
        /* Full Frame */
        var countsLen = r.vi();
        var counts = new Array(countsLen);
        for(var i=0; i<countsLen; i++) counts[i] = r.vi();
        var charsStr = r.str();
        curC = '';
        for(var i=0; i<countsLen; i++) curC += charsStr[i].repeat(counts[i]);

        if (this.color) {
          if (r.u8() === 1) {
            var colorRleLen = r.vi();
            curCI = [];
            for(var i=0; i<colorRleLen; i+=2) {
              var cn = r.vi();
              var cv = r.vi();
              for(var j=0; j<cn; j++) curCI.push(cv);
            }
          }
        }
      } else if (type === 2) {
        /* Delta Frame */
        var gapsLen = r.vi();
        var pos = new Array(gapsLen);
        var p = 0;
        for(var i=0; i<gapsLen; i++) { p += r.vi(); pos[i] = p; }

        var charsStr = r.str();
        var a = prevC.split('');
        for(var i=0; i<gapsLen; i++) a[pos[i]] = charsStr[i];
        curC = a.join('');

        if (this.color && prevCI) {
          curCI = prevCI.slice();
          if (r.u8() === 1) {
            var cgLen = r.vi();
            var cp = new Array(cgLen);
            var cpv = 0;
            for(var i=0; i<cgLen; i++) { cpv += r.vi(); cp[i] = cpv; }
            for(var i=0; i<cgLen; i++) curCI[cp[i]] = r.vi();
          }
        }
      }

      this.frames.push(curC);
      if (this.colors) {
        if (curCI && this._colorDict) {
          var d = this._colorDict;
          this.colors.push(curCI.map(function(idx) { return d[idx] || [0,0,0]; }));
        } else { this.colors.push(null); }
      }
      prevC = curC;
      if (curCI) prevCI = curCI;
    }

    this._frameIndex = 0;
    this._timer = null;
    this._pre = null;
    this._el = null;
  }
  _decodeV4Frames(rawFrames) {
    var tc = this.width * this.height;
    this.frames = [];
    this.colors = this.color ? [] : null;
    var prevC = ' '.repeat(tc);
    var prevCI = this.color ? new Array(tc).fill(0) : null;

    for (var fi = 0; fi < rawFrames.length; fi++) {
      var f = rawFrames[fi];
      var curC, curCI;

      if (f.d === 1) {
        /* Duplicate */
        curC = prevC; curCI = prevCI;
      } else if (f.dp !== undefined) {
        /* Delta frame: gap-encoded positions */
        var pos = _ug(f.dp);
        var a = prevC.split('');
        for (var i = 0; i < pos.length; i++) a[pos[i]] = f.dc[i];
        curC = a.join('');
        if (this.color && prevCI) {
          curCI = prevCI.slice();
          if (f.cp) {
            var cp = _ug(f.cp), cv = _dv(f.cv);
            for (var i = 0; i < cp.length; i++) curCI[cp[i]] = cv[i];
          }
        }
      } else {
        /* Full frame: split char RLE (cn/cc) or varint int RLE */
        if (f.cn !== undefined) {
          var counts = _dv(f.cn); curC = '';
          for (var i = 0; i < counts.length; i++) curC += f.cc[i].repeat(counts[i]);
        } else {
          curC = this._decodeRLE(f.chars);
        }
        if (this.color) {
          if (f.ci && typeof f.ci === 'string') {
            var arr = _dv(f.ci); curCI = [];
            for (var i = 0; i < arr.length; i += 2) { for (var j = 0; j < arr[i]; j++) curCI.push(arr[i+1]); }
          } else if (f.ci) { curCI = this._decodeIntRLE(f.ci); }
        }
      }

      this.frames.push(curC);
      if (this.colors) {
        if (curCI && this._colorDict) {
          var d = this._colorDict;
          this.colors.push(curCI.map(function(idx) { return d[idx] || [0,0,0]; }));
        } else { this.colors.push(null); }
      }
      prevC = curC;
      if (curCI) prevCI = curCI;
    }
  }

  /* ── V2/V3 frame decoder (backward compat) ── */
  _decodeV2Frames(rawFrames) {
    var tc = this.width * this.height;
    this.frames = [];
    this.colors = this.color ? [] : null;
    var prevC = ' '.repeat(tc);
    var prevCI = this.color ? new Array(tc).fill(0) : null;

    for (var fi = 0; fi < rawFrames.length; fi++) {
      var f = rawFrames[fi];
      var curC, curCI;

      if (f.d === 1) {
        curC = prevC; curCI = prevCI;
      } else if (f.cd) {
        var a = prevC.split('');
        for (var i = 0; i < f.cd.length; i += 2) a[f.cd[i]] = f.cd[i + 1];
        curC = a.join('');
        if (this.color && prevCI) {
          curCI = prevCI.slice();
          if (f.cid) { for (var i = 0; i < f.cid.length; i += 2) curCI[f.cid[i]] = f.cid[i + 1]; }
        }
      } else {
        curC = this._decodeRLE(f.chars);
        if (this.color && f.ci) { curCI = this._decodeIntRLE(f.ci); }
        else if (this.color && f.colors) {
          curCI = null;
          if (this.colors) { this.frames.push(curC); this.colors.push(f.colors ? this._decodeColorRLE(f.colors) : null); prevC = curC; continue; }
        }
      }

      this.frames.push(curC);
      if (this.colors) {
        if (curCI && this._colorDict) {
          var d = this._colorDict;
          this.colors.push(curCI.map(function(idx) { return d[idx] || [0,0,0]; }));
        } else { this.colors.push(null); }
      }
      prevC = curC;
      if (curCI) prevCI = curCI;
    }
  }

  _decodeRLE(rle) {
    var o = '';
    for (var i = 0; i < rle.length; i += 2) o += rle[i+1].repeat(rle[i]);
    return o;
  }
  _decodeIntRLE(rle) {
    var o = [];
    for (var i = 0; i < rle.length; i += 2) { for (var j = 0; j < rle[i]; j++) o.push(rle[i+1]); }
    return o;
  }
  _decodeColorRLE(rle) {
    var o = [];
    for (var i = 0; i < rle.length; i += 2) { for (var j = 0; j < rle[i]; j++) o.push(rle[i+1]); }
    return o;
  }

  mount(el) {
    this._el = el;
    this._pre = document.createElement('pre');
    var bg = (this.render && this.render.theme && this.render.theme.bg) || '#000';
    this._pre.style.cssText = 'font-family:Consolas,Menlo,monospace;font-size:6px;line-height:0.8em;letter-spacing:0;padding:4px;overflow:auto;margin:0;white-space:pre;background:' + bg + ';';
    el.appendChild(this._pre);
    this._render(0);
  }

  play() {
    this.stop();
    var self = this;
    this._timer = setInterval(function() {
      self._frameIndex = (self._frameIndex + 1) % self.frames.length;
      self._render(self._frameIndex);
    }, 1000 / this.fps);
  }

  stop() { if (this._timer) { clearInterval(this._timer); this._timer = null; } }

  _render(idx) {
    var chars = this.frames[idx];
    var mode = (this.render && this.render.mode) || 'truecolor';
    if (mode === 'mono') {
      var theme = (this.render && this.render.theme) || {};
      this._pre.style.background = theme.bg || '#000';
      this._pre.style.color = theme.fg || '#0f0';
      var text = '';
      for (var row = 0; row < this.height; row++) text += chars.slice(row * this.width, (row + 1) * this.width) + '\\n';
      this._pre.textContent = text;
      return;
    }
    var colorData = (this.color && this.colors) ? this.colors[idx] : null;
    var html = '', runColor = null, runChars = '';
    function flushRun() {
      if (!runChars) return;
      if (runColor) html += '<span style=\"color:rgb(' + runColor[0] + ',' + runColor[1] + ',' + runColor[2] + ')\">' + runChars + '</span>';
      else html += runChars;
      runChars = '';
    }
    for (var row = 0; row < this.height; row++) {
      for (var col = 0; col < this.width; col++) {
        var i = row * this.width + col;
        var ch = chars[i] || ' ';
        var esc = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
        var cellColor = (colorData && colorData[i]) ? colorData[i] : null;
        var sameColor = runColor && cellColor && runColor[0] === cellColor[0] && runColor[1] === cellColor[1] && runColor[2] === cellColor[2];
        if (!sameColor && (runColor || cellColor)) { flushRun(); runColor = cellColor; }
        runChars += esc;
      }
      flushRun(); runColor = null; html += '\\n';
    }
    flushRun();
    this._pre.innerHTML = html;
  }
}
AsciiPlayer.__empty = function() {};
AsciiPlayer.__empty.prototype = AsciiPlayer.prototype;
`;

export default PLAYER_SOURCE;
