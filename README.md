# ASCII-fi

| Original (3.0mb)               | ASCII Preview (0.3mb)    |
| ------------------------------ | ------------------------ |
| ![Original](docs/original.gif) | ![ASCII](docs/ascii.gif) |

**ASCII-fi** is a high-performance video-to-ASCII conversion engine. It features a lightweight resource footprint and is optimized for both visual fidelity and storage efficiency. With support for real-time bundle size estimation, automatic vertical video orientation, and high-precision color quantization, ASCII-fi transforms any video into stunning, portable ASCII animations for the web or terminal.

It operates seamlessly as a **Standalone Interactive CLI/GUI** and as a **Programmatic NPM Library**, allowing for flexible standalone consumption or direct integrations inside your backend environments.

## Architecture & Efficiency

- **Stream-based processing** – FFmpeg pipes raw frames directly to Node.js; no temporary files are written to disk.
- **Resolution-safe downscaling** – Input videos (ranging up to 4K natively) are downscaled heavily before processing preventing V8 memory overflows.
- **Resource Constraints** – By bypassing external file writing and managing delta encoding internally, `ASCII-fi` scales linearly and maintains a highly restricted memory footprint suitable for tiny shared VPS hosting.
- **Binary payloads** – Output web bundles utilize raw binary serialization and GZIP compression for incredibly minimal file size (often 90% space reduction).

## Quick Start

Currently, `ASCII-fi` is not distributed on the npm registry. You can install it directly from GitHub or by downloading the repository ZIP.

### Local CLI & GUI Usage

If you want to run the application to convert a video to ASCII natively on your machine:

```bash
git clone https://github.com/iman-hussain/ASCII-fy.git
cd ASCII-fy
npm install

# (Optional) Link it to use the "ASCII-fi" command globally
npm link
```

### Local Installation (Programmatic API)

To use `ASCII-fi` within your own Node.js projects, you can install it directly via the GitHub repository URL, or by pointing npm to a local folder:

```bash
npm install github:iman-hussain/ASCII-fy
# OR
npm install /path/to/extracted/ASCII-fy/folder
> Requires Node.js >= 18. FFmpeg bindings are handled automatically via `ffmpeg-static`.

> [!TIP]
> **Permission Issues?** If you are running `ASCII-fi` on Linux or via Docker and encounter `EACCES` permission errors when generating animations, ensure your user owns the project root so Node can generate the `output` folder:
> ```bash
> sudo chown -R $USER output
> ```

---

## 🖥️ CLI Usage

If installed globally (or running locally via `npm start`), you can initiate `ASCII-fi`.

```bash
# Interactive mode (Prompts you step-by-step for files and settings)
ASCII-fi

# Fast-CLI mode (Bypasses prompts entirely for rapid executions or cronjobs)
ASCII-fi input/dog.mp4 --width 120 --fps 30 --mode truecolor
```

### 🎮 Terminal Playback

Once you have generated an animation (typically saved as `bundle.js`), you can play it natively in your terminal using the standalone `ascii-player.js` utility.

```bash
# Play a bundle in your terminal
node scripts/ascii-player.js output/dog/bundle.js
```

> [!NOTE]
> **Performance:** For the best experience (smooth 60fps truecolor), we recommend using the modern **Windows Terminal** or a terminal with full GPU acceleration. Choose a small width (e.g., 60-80 columns) for optimal performance.

### Available CLI Flags

| Flag                   | Description                                                                       | Default     |
| ---------------------- | --------------------------------------------------------------------------------- | ----------- |
| `<file>`               | The positional argument specifying the video path                                 | -           |
| `-w, --width <n>`      | Output character width                                                            | 100         |
| `-f, --fps <n>`        | Output playback frame rate                                                        | 24          |
| `-m, --mode <mode>`    | Color styling (`truecolor`, `mono`, `palette`, `kmeans`)                          | `truecolor` |
| `-d, --depth <n>`      | Palette color calculation density (2-64)                                          | 16          |
| `-p, --palette <name>` | Preset selections (`realistic`, `grayscale`, `sunset`, `ocean`, `neon`, `forest`) | -           |
| `--fg <hex>`           | Mono mode foreground color                                                        | `#00ff00`   |
| `--bg <hex\|auto>`     | Mono mode and player background color                                             | `#000000`   |
| `-g, --char-mode`      | Mode style (`ascii` edge detection or `block` solid colors)                       | `ascii`     |
| `-s, --start <sec>`    | Video slice starting point (seconds)                                              | -           |
| `-e, --end <sec>`      | Video slice ending point (seconds)                                                | -           |
| `--no-gif`             | Skip GIF preview generation                                                       | -           |
| `--no-open`            | Skip opening the browser/HTML automatically on completion                         | -           |

---

## 🌐 GUI Usage

ASCII-fi ships with an integrated local Web UI enabling real-time tweaks via a graphical interface.

1. Navigate to the installation directory.
2. Windows: Run `start.bat`
3. macOS/Linux: Run `./start.sh`

The local server boots natively without external dependencies, spinning up a clean viewport. You can live-preview conversions, select foreground isolation (via ONNX ML segmentations), or capture conversions strictly from your WebCam stream.

---

## 🛠️ Programmatic API

When importing `ascii-fi`, you receive access to the full video generation capabilities without side-effect generating loaders, as well as an inline Terminal Player for CLI dashboards.

### 1. Generating Bundles

The programmatic interface guarantees memory efficiency and throws standard JavaScript `Error` objects on failure.

```js
import { generateBundle } from 'ascii-fi';

try {
  const result = await generateBundle({
    inputFile: 'input/my-video.webm', // Required
    outDir: 'output',                 // Optional output directory
    width: 80,                        // Options map directly to CLI flags
    fps: 24,
    mode: 'truecolor',
    skipGif: true                     // Generate bundle.js ONLY
  });

  console.log('Bundle Saved To:', result.bundlePath);
  console.log('Statistics:', result.stats);
} catch (err) {
  console.error("Conversion failed:", err.message);
}
```

### 2. Terminal Player Integration

The programmatic interface exposes a native `TerminalPlayer` capable of parsing your compressed output payloads (`bundle.js`) directly in Node.js and accurately repainting ASCII frames inside the host terminal natively via precise truecolor ANSI sequence jumping (no terminal history bloat!).

```js
import fs from 'node:fs/promises';
import { TerminalPlayer } from 'ascii-fi';

// Intercept your generated JS file from step 1
const scriptContent = await fs.readFile('output/bundle.js', 'utf8');
const match = scriptContent.match(/__ASCII_COMPRESSED__="([^"]+)"/);

// Boot player logic
const player = TerminalPlayer.fromCompressed(match[1]);

// Yield controls to Node event loop (non-blocking)
player.play();
setTimeout(() => player.stop(), 5000); // Interrupts gracefully
```

### 3. Standalone Terminal Player

The `scripts/ascii-player.js` script in the root is a standalone, zero-dependency utility that can be shared and used to play any `bundle.js` file generated by `ASCII-fi`. This is ideal for CI/CD environments or sharing animations without requiring the full library.
