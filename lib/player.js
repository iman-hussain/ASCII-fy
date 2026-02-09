/**
 * ascii-fy – Client-side AsciiPlayer class (v3).
 *
 * Embedded directly into the generated bundle.js.
 * Handles:
 *   - Native gzip decompression via DecompressionStream (zero deps)
 *   - Colour dictionary lookup
 *   - Delta frame decoding  +  RLE decompression
 *   - Rendering to DOM via <pre> with per-cell <span> colouring.
 *
 * NOTE: This is a **template string** inlined into the bundle.
 *       Must be valid standalone browser JS (no imports / no template literals).
 */

const PLAYER_SOURCE = `
class AsciiPlayer {
  constructor(data) { this._init(data); }

  /* Async factory – decode base64, then decompress gzip with native DecompressionStream (zero deps). */
  static async fromCompressed(b64) {
    var bin = Uint8Array.from(atob(b64), function(c) { return c.charCodeAt(0); });
    var ds = new DecompressionStream('gzip');
    var blob = new Blob([bin]);
    var stream = blob.stream().pipeThrough(ds);
    var text = await new Response(stream).text();
    var data = JSON.parse(text);
    var p = new AsciiPlayer.__empty();
    p._init(data);
    return p;
  }

  _init(data) {
    this.width  = data.width;
    this.height = data.height;
    this.fps    = data.fps || 24;
    this.color  = data.color || false;
    this.render = data.render || { mode: 'truecolor', theme: { fg: '#00ff00', bg: '#000000' } };
    this._colorDict = data.colorDict || null;

    if (data.v >= 2) { this._decodeV2Frames(data.frames); }
    else {
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
    if (bg === 'transparent') bg = '#000';
    this._pre.style.cssText =
      'font-family:Consolas,Menlo,monospace;font-size:6px;' +
      'line-height:6px;letter-spacing:0;' +
      'padding:4px;overflow:auto;margin:0;white-space:pre;background:' + bg + ';';
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

  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  _render(idx) {
    var chars = this.frames[idx];
    var mode = (this.render && this.render.mode) || 'truecolor';

    if (mode === 'mono') {
      var theme = (this.render && this.render.theme) || {};
      this._pre.style.background = theme.bg || '#000';
      this._pre.style.color = theme.fg || '#0f0';
      var text = '';
      for (var row = 0; row < this.height; row++) {
        text += chars.slice(row * this.width, (row + 1) * this.width) + '\\n';
      }
      this._pre.textContent = text;
      return;
    }

    var colorData = (this.color && this.colors) ? this.colors[idx] : null;
    var html = '';
    var runColor = null;
    var runChars = '';

    function flushRun() {
      if (!runChars) return;
      if (runColor) {
        html += '<span style=\"color:rgb(' + runColor[0] + ',' + runColor[1] + ',' + runColor[2] + ')\">' + runChars + '</span>';
      } else { html += runChars; }
      runChars = '';
    }

    for (var row = 0; row < this.height; row++) {
      for (var col = 0; col < this.width; col++) {
        var i = row * this.width + col;
        var ch = chars[i] || ' ';
        var esc = ch === '<' ? '&lt;' : ch === '>' ? '&gt;' : ch === '&' ? '&amp;' : ch;
        var cellColor = (colorData && colorData[i]) ? colorData[i] : null;

        var sameColor = runColor && cellColor &&
          runColor[0] === cellColor[0] && runColor[1] === cellColor[1] && runColor[2] === cellColor[2];
        if (!sameColor && (runColor || cellColor)) {
          flushRun();
          runColor = cellColor;
        }
        runChars += esc;
      }
      flushRun();
      runColor = null;
      html += '\\n';
    }
    flushRun();
    this._pre.innerHTML = html;
  }
}

AsciiPlayer.__empty = function() {};
AsciiPlayer.__empty.prototype = AsciiPlayer.prototype;
`;

export default PLAYER_SOURCE;
