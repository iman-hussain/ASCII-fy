# ascii-fy

High-performance CLI tool that converts video files into lightweight ASCII art animations for the web.

## Features

- **Stream-based architecture** – FFmpeg pipes raw frames directly to Node.js; no temporary files are written to disk.
- **Resolution-safe** – Input videos (720p, 1080p, 4K) are downscaled via FFmpeg before processing, preventing memory overflows.
- **RLE compression** – Generated web bundles use Run-Length Encoding for minimal file size.
- **Web playable** – Outputs a self-contained `demo.html` + `bundle.js` that plays the animation in any browser.
- **Terminal preview** – Optionally plays the ASCII animation directly in your terminal.
- **Color support** – Full 24-bit color by default, with post-conversion palettes.
- **Input types** – Supports `.mp4`, `.gif`, and `.webm` inputs.
- **Trim support** – Convert only a specific segment of a video (start/end time).
- **Live tweaks** – Adjust foreground/background colors and re-generate outputs on demand.

## Installation

```bash
npm install
```

> Requires Node.js >= 18 and **FFmpeg** (bundled via `ffmpeg-static`).

## Usage

### GUI

Windows:

```bat
start.bat
```

macOS/Linux:

```bash
./start.sh
```

### CLI

```bash
node index.js
```

The interactive CLI will prompt you for:

1. **Input file** – scans the `input/` folder for `.mp4`, `.mov`, `.webm`, etc.
2. **Output width** – target character width (default: 100).
3. **Trim (optional)** – start/end time in seconds to convert only part of the video.

The terminal preview runs automatically after conversion. You can then choose render styles like:

- Truecolor (source)
- Monochrome (custom fg/bg)
- Grayscale 4-bit / 6-bit / 8-bit
- Gradient palettes (Sunset, Ocean, Neon, Forest) or a custom 3-color gradient

The tool auto-creates `input/` and `output/` folders next to your video file if they do not already exist.
After conversion, open the generated `demo.html` in a browser to view the animation.

## Output

Each conversion writes to `output/<video-name>/`:

| File         | Description                                        |
| ------------ | -------------------------------------------------- |
| `bundle.js`  | RLE-compressed frame data + embedded `AsciiPlayer` |
| `demo.html`  | Standalone HTML page with play/stop controls       |
| `preview.gif`| ASCII GIF preview (generated from frames)          |

## Architecture

```text
Video File
  │
  ▼
FFmpeg (child process)
  │  -vf scale=W:-2   ← downscale to target width
  │  -pix_fmt rgb24    ← 3 bytes/pixel
  │  -f image2pipe     ← stream to stdout
  ▼
Converter Engine (lib/converter.js)
  │  Uint8Array pixel loop
  │  Luminance → ASCII char mapping
  ▼
Bundler (lib/bundler.js)
  │  Run-Length Encoding
  │  Embed AsciiPlayer class
  ▼
bundle.js + demo.html
```

## License

MIT
