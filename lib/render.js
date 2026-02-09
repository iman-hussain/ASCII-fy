/**
 * ascii-fy – Shared rendering helpers for color mapping.
 */

export const CHAR_RAMP = " .:;+=*#%@";
// Block ramp: space → light shade → medium → dark → full block.
// Used exclusively in block char mode for a clean pixel-art look.
export const BLOCK_RAMP = " ░▒▓█";
// Dense ramp for color mode to avoid empty background holes.
export const COLOR_RAMP = "█▓▒░";

export function charToLevel(ch) {
  const idx = CHAR_RAMP.indexOf(ch);
  if (idx <= 0) return 0;
  return idx / (CHAR_RAMP.length - 1);
}

export function makeGrayscalePalette(steps) {
  const palette = [];
  const count = Math.max(2, steps);
  for (let i = 0; i < count; i++) {
    const v = Math.round((i / (count - 1)) * 255);
    palette.push([v, v, v]);
  }
  return palette;
}

export function makeGradientPalette(stops, steps) {
  const palette = [];
  const count = Math.max(2, steps);
  const segments = stops.length - 1;
  for (let i = 0; i < count; i++) {
    const t = i / (count - 1);
    const seg = Math.min(segments - 1, Math.floor(t * segments));
    const localT = (t - seg / segments) * segments;
    const a = stops[seg];
    const b = stops[seg + 1];
    palette.push([
      Math.round(a[0] + (b[0] - a[0]) * localT),
      Math.round(a[1] + (b[1] - a[1]) * localT),
      Math.round(a[2] + (b[2] - a[2]) * localT),
    ]);
  }
  return palette;
}

export function contrastColor(r, g, b) {
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 128) {
    return [Math.round(r * 0.3), Math.round(g * 0.3), Math.round(b * 0.3)];
  }
  return [
    Math.min(255, Math.round(r * 2 + 40)),
    Math.min(255, Math.round(g * 2 + 40)),
    Math.min(255, Math.round(b * 2 + 40))
  ];
}

export function nearestPaletteColor(rgb, palette) {
  if (!palette || !palette.length || !rgb) return rgb;
  let bestDist = Infinity;
  let best = palette[0];
  for (let i = 0; i < palette.length; i++) {
    const dr = rgb[0] - palette[i][0];
    const dg = rgb[1] - palette[i][1];
    const db = rgb[2] - palette[i][2];
    const d = dr * dr + dg * dg + db * db;
    if (d < bestDist) { bestDist = d; best = palette[i]; }
  }
  return best;
}

/* ── Realistic colour pool ─────────────────────────────────────────── */
// ~70 curated real-world anchor colours covering shadows, midtones
// highlights, skin, sky, foliage, earth, fabric, metal, etc.
const REALISTIC_POOL = [
  // ─ Shadows / near-black
  [4,4,6],     [12,12,18],  [20,16,14],  [28,22,30],
  // ─ Dark cool (deep blue, charcoal, slate)
  [18,28,48],  [30,40,60],  [44,50,68],  [35,35,45],
  // ─ Dark warm (brown, maroon, dark olive)
  [48,28,18],  [60,34,22],  [50,44,28],  [40,50,30],
  // ─ Mid shadows
  [60,60,70],  [72,68,62],  [55,75,90],  [80,55,45],
  // ─ Earth tones (ochre, sienna, clay, khaki)
  [140,100,55],[170,120,70],[130,90,50],  [160,140,100],
  // ─ Skin tones (light → dark)
  [90,60,45],  [140,100,80],[180,140,110],[220,185,155],
  [200,160,130],[240,210,180],[110,78,55],
  // ─ Foliage / greens
  [30,60,28],  [50,90,40],  [70,120,50], [100,140,70],
  [140,170,90],[40,75,40],  [80,100,55],
  // ─ Sky / blues
  [40,80,140], [70,120,180],[100,155,210],[140,185,230],
  [170,200,240],[55,100,160],
  // ─ Water / teal
  [30,90,100], [50,130,140],[80,160,170],[40,110,120],
  // ─ Warm midtones (terracotta, salmon, peach)
  [180,100,70],[200,130,90],[220,160,120],[200,110,80],
  // ─ Cool midtones (slate blue, mauve, lilac)
  [100,100,130],[130,120,150],[160,145,170],[90,85,110],
  // ─ Neutrals  / grays
  [90,90,92],  [120,120,118],[150,150,148],[180,180,178],
  [60,60,58],  [105,105,102],
  // ─ Highlights / pastels
  [200,195,180],[220,215,200],[210,200,220],[200,220,210],
  [240,230,210],[230,220,240],
  // ─ Bright accents (restrained – for occasional punchy detail)
  [200,60,50], [60,140,200],[80,180,80],  [220,180,50],
  // ─ Near-white / white
  [235,235,230],[245,243,238],[252,252,250],[255,255,255],
];

/**
 * Build a "realistic" palette of N colours by farthest-point-first
 * selection from the curated pool. Guarantees maximum perceptual
 * spread at every depth count – works for any N from 2 to 64+.
 */
export function makeRealisticPalette(count) {
  const pool = REALISTIC_POOL;
  const n = Math.max(2, Math.min(count, pool.length));

  // Farthest-point-first greedy selection
  const selected = [0]; // start with near-black
  const minDist = new Float64Array(pool.length).fill(Infinity);

  for (let i = 1; i < n; i++) {
    const last = pool[selected[selected.length - 1]];
    for (let j = 0; j < pool.length; j++) {
      const dr = pool[j][0] - last[0];
      const dg = pool[j][1] - last[1];
      const db = pool[j][2] - last[2];
      const d = dr * dr + dg * dg + db * db;
      if (d < minDist[j]) minDist[j] = d;
    }
    let best = -1, bestD = -1;
    for (let j = 0; j < pool.length; j++) {
      if (minDist[j] > bestD) { bestD = minDist[j]; best = j; }
    }
    selected.push(best);
    minDist[best] = 0;
  }

  // Sort by luminance
  return selected
    .map(i => pool[i])
    .sort((a, b) =>
      (0.299 * a[0] + 0.587 * a[1] + 0.114 * a[2]) -
      (0.299 * b[0] + 0.587 * b[1] + 0.114 * b[2])
    );
}

export function pickColorForChar(ch, render, frameColor, fallbackFg) {
  if (render?.mode === 'truecolor') {
    return frameColor || fallbackFg;
  }
  if (render?.mode === 'mono') {
    return fallbackFg;
  }
  if (render?.mode === 'palette' && render?.palette?.length) {
    // If we have source color data, snap it to nearest palette color
    if (frameColor) {
      return nearestPaletteColor(frameColor, render.palette);
    }
    // Fallback: map character luminance to palette
    const level = charToLevel(ch);
    const idx = Math.min(render.palette.length - 1, Math.max(0, Math.round(level * (render.palette.length - 1))));
    return render.palette[idx];
  }
  return fallbackFg;
}
