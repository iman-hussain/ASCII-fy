/**
 * ascii-fy – ML-based adaptive palette extraction.
 *
 * Uses k-means clustering on sampled pixel colours to derive an
 * optimal N-colour palette that best represents the actual source
 * image, rather than relying on hand-picked gradient presets.
 *
 * The algorithm:
 *   1. Sample pixels from one or more frames (fast sub-sampling).
 *   2. Run k-means in RGB space with k = desired palette size.
 *   3. Sort resulting centroids by luminance for consistent ordering.
 *   4. Optionally boost saturation/spread of centroids so they remain
 *      distinguishable at low colour depths.
 *
 * This is "ML-lite" – fully deterministic once seeded, runs in <50 ms
 * for typical frame sizes, and produces dramatically better palettes
 * than fixed gradients for arbitrary source material.
 */

/**
 * Run k-means clustering on an array of [r,g,b] samples.
 *
 * @param {number[][]} samples – array of [r,g,b] triples
 * @param {number}     k       – number of clusters
 * @param {number}     [maxIter=20] – iteration cap
 * @returns {number[][]} k centroids sorted by luminance
 */
export function kMeansRGB(samples, k, maxIter = 20) {
	if (samples.length === 0) return [];
	k = Math.min(k, samples.length);

	// --- Initialise centroids with k-means++ ---
	const centroids = kMeansPlusPlusInit(samples, k);

	const assignments = new Int32Array(samples.length);

	for (let iter = 0; iter < maxIter; iter++) {
		// Assignment step
		let changed = false;
		for (let i = 0; i < samples.length; i++) {
			const nearest = nearestCentroid(samples[i], centroids);
			if (nearest !== assignments[i]) {
				assignments[i] = nearest;
				changed = true;
			}
		}
		if (!changed) break;

		// Update step – recompute centroids
		const sums = Array.from({ length: k }, () => [0, 0, 0]);
		const counts = new Int32Array(k);

		for (let i = 0; i < samples.length; i++) {
			const c = assignments[i];
			sums[c][0] += samples[i][0];
			sums[c][1] += samples[i][1];
			sums[c][2] += samples[i][2];
			counts[c]++;
		}

		for (let c = 0; c < k; c++) {
			if (counts[c] > 0) {
				centroids[c] = [
					Math.round(sums[c][0] / counts[c]),
					Math.round(sums[c][1] / counts[c]),
					Math.round(sums[c][2] / counts[c]),
				];
			}
		}
	}

	// Sort by luminance for consistent ordering
	centroids.sort((a, b) => luminance(a) - luminance(b));
	return centroids;
}

/**
 * k-means++ initialisation – picks well-spread initial centroids.
 */
function kMeansPlusPlusInit(samples, k) {
	const centroids = [];

	// Pick first centroid uniformly at random (deterministic: middle)
	centroids.push([...samples[Math.floor(samples.length / 2)]]);

	for (let c = 1; c < k; c++) {
		// Compute distance from each sample to nearest existing centroid
		let totalDist = 0;
		const dists = new Float64Array(samples.length);
		for (let i = 0; i < samples.length; i++) {
			let minD = Infinity;
			for (let j = 0; j < centroids.length; j++) {
				const d = dist2(samples[i], centroids[j]);
				if (d < minD) minD = d;
			}
			dists[i] = minD;
			totalDist += minD;
		}

		// Pick next centroid proportional to distance²
		// Use deterministic approach: pick the sample with highest distance
		let bestIdx = 0;
		let bestDist = -1;
		for (let i = 0; i < samples.length; i++) {
			if (dists[i] > bestDist) {
				bestDist = dists[i];
				bestIdx = i;
			}
		}
		centroids.push([...samples[bestIdx]]);
	}

	return centroids;
}

function nearestCentroid(pixel, centroids) {
	let best = 0;
	let bestD = Infinity;
	for (let i = 0; i < centroids.length; i++) {
		const d = dist2(pixel, centroids[i]);
		if (d < bestD) { bestD = d; best = i; }
	}
	return best;
}

function dist2(a, b) {
	const dr = a[0] - b[0];
	const dg = a[1] - b[1];
	const db = a[2] - b[2];
	return dr * dr + dg * dg + db * db;
}

function luminance(c) {
	return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}

/**
 * Sample pixel colours from a raw RGB24 buffer.
 *
 * @param {Uint8Array} pixels – raw RGB24 data
 * @param {number} [maxSamples=2000] – cap to keep k-means fast
 * @returns {number[][]} array of [r,g,b]
 */
export function samplePixels(pixels, maxSamples = 2000) {
	const totalPixels = Math.floor(pixels.length / 3);
	const step = Math.max(1, Math.floor(totalPixels / maxSamples));
	const samples = [];
	for (let i = 0; i < totalPixels && samples.length < maxSamples; i += step) {
		const idx = i * 3;
		samples.push([pixels[idx], pixels[idx + 1], pixels[idx + 2]]);
	}
	return samples;
}

/**
 * Boost centroid spread to ensure distinguishable colours at low depths.
 * Pushes centroids apart in RGB space while keeping them in gamut.
 *
 * @param {number[][]} centroids
 * @param {number}     [strength=0.3] – 0 = no change, 1 = maximum spread
 * @returns {number[][]}
 */
export function spreadCentroids(centroids, strength = 0.3) {
	if (centroids.length < 2) return centroids;

	// Compute mean colour
	const mean = [0, 0, 0];
	for (const c of centroids) {
		mean[0] += c[0]; mean[1] += c[1]; mean[2] += c[2];
	}
	mean[0] /= centroids.length;
	mean[1] /= centroids.length;
	mean[2] /= centroids.length;

	// Push each centroid away from the mean
	return centroids.map((c) => [
		clamp(Math.round(c[0] + (c[0] - mean[0]) * strength), 0, 255),
		clamp(Math.round(c[1] + (c[1] - mean[1]) * strength), 0, 255),
		clamp(Math.round(c[2] + (c[2] - mean[2]) * strength), 0, 255),
	]);
}

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

/**
 * High-level: sample a video frame and extract an optimal k-colour palette.
 *
 * @param {string} inputPath
 * @param {number} outputWidth
 * @param {object} meta – { width, height }
 * @param {number} k    – palette size
 * @param {object} [crop] - { x, y, w, h } cropping parameters
 * @returns {Promise<number[][]>} palette of k [r,g,b] centroids
 */
export async function extractPaletteFromVideo(inputPath, outputWidth, meta, k, crop) {
	const { spawn } = await import('node:child_process');
	const ffmpegPath = (await import('ffmpeg-static')).default;

	const validCrop = crop && crop.w && crop.h;
	const srcW = validCrop ? crop.w : meta.width;
	const srcH = validCrop ? crop.h : meta.height;

	const scaledH = Math.max(1, Math.round((outputWidth / srcW) * srcH / 2));

	const filters = [];
	if (validCrop) {
		filters.push(`crop=${crop.w}:${crop.h}:${crop.x || 0}:${crop.y || 0}`);
	}
	filters.push(`scale=${outputWidth}:${scaledH}:flags=fast_bilinear`);

	const args = [
		'-ss', '0',
		'-i', inputPath,
		'-frames:v', '3',          // sample up to 3 frames
		'-f', 'image2pipe',
		'-vcodec', 'rawvideo',
		'-pix_fmt', 'rgb24',
		'-vf', filters.join(','),
		'-',
	];

	const pixels = await new Promise((resolve) => {
		const proc = spawn(ffmpegPath, args, { stdio: ['ignore', 'pipe', 'pipe'] });
		const chunks = [];
		proc.stdout.on('data', (c) => chunks.push(c));
		proc.on('close', () => resolve(Buffer.concat(chunks)));
		proc.on('error', () => resolve(Buffer.alloc(0)));
	});

	if (pixels.length < 3) return null;
	const samples = samplePixels(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), 3000);
	const centroids = kMeansRGB(samples, k);

	// Apply gentle spread for low depths
	const strength = k <= 4 ? 0.15 : k <= 16 ? 0.08 : k <= 32 ? 0.04 : 0.02;
	return spreadCentroids(centroids, strength);
}
