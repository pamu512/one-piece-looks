/**
 * Color math for sampling, shift description, and palette harmonization.
 * All colors are #RRGGBB. Pure functions; no dependencies.
 */

export interface RGB {
  r: number;
  g: number;
  b: number;
}

const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export function isHex(value: string): value is `#${string}` {
  return HEX_RE.test(value);
}

/** Parse "#RRGGBB" to 0-255 channels. Throws on malformed input. */
export function hexToRgb(hex: string): RGB {
  if (!isHex(hex)) throw new Error(`invalid hex color: ${hex}`);
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

export function rgbToHex({ r, g, b }: RGB): string {
  const c = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n)))
      .toString(16)
      .padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toLowerCase();
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/**
 * Perceptual-ish distance. Weighted RGB is crude; we blend it with a
 * red-mean term (a cheap CIE approximation) which behaves well for the
 * skin/makeup gamut we care about.
 */
export function colorDistance(a: string, b: string): number {
  const { r: r1, g: g1, b: b1 } = hexToRgb(a);
  const { r: r2, g: g2, b: b2 } = hexToRgb(b);
  const rMean = (r1 + r2) / 2;
  const dr = r1 - r2;
  const dg = g1 - g2;
  const db = b1 - b2;
  const wr = 2 + rMean / 256;
  const wg = 4;
  const wb = 2 + (255 - rMean) / 256;
  return Math.sqrt(wr * dr * dr + wg * dg * dg + wb * db * db);
}

/** Max distance between two colors in this metric (~765). */
export const MAX_DISTANCE = 765;

/** sRGB -> relative luminance (0..1). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Contrast ratio between two colors (1..21). Used for shift line labels. */
export function contrastRatio(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

/** Linear interpolation between two colors. t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex({
    r: ca.r + (cb.r - ca.r) * k,
    g: ca.g + (cb.g - ca.g) * k,
    b: ca.b + (cb.b - ca.b) * k,
  });
}

/**
 * Shift hue by degrees in HSL space, keeping S and L. Used to harmonize
 * supporting-layer colors with the locked shade.
 */
export function shiftHue(hex: string, degrees: number): string {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const max = Math.max(rn, gn, bn),
    min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0,
    s = 0;
  const d = max - min;
  if (d !== 0) {
    s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  h = (h + degrees + 360) % 360;
  // HSL -> RGB
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0,
    gg = 0,
    bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  return rgbToHex({ r: (rr + m) * 255, g: (gg + m) * 255, b: (bb + m) * 255 });
}

/** Scale lightness-ish by factor around mid-gray; <1 darkens, >1 lightens. */
export function shade(hex: string, factor: number): string {
  const c = hexToRgb(hex);
  return rgbToHex({
    r: 128 + (c.r - 128) * factor,
    g: 128 + (c.g - 128) * factor,
    b: 128 + (c.b - 128) * factor,
  });
}

/**
 * Hue-ish classification for makeup copy and palette harmonization.
 * Returns one of the friendly families the recipe builder speaks in.
 * Boundaries tuned on reference makeup shades (see color.test.ts).
 */
export type ColorFamily =
  | "red"
  | "berry"
  | "pink"
  | "nude"
  | "peach"
  | "coral"
  | "orange"
  | "brown"
  | "mauve"
  | "plum"
  | "neutral";

export function classifyFamily(hex: string): ColorFamily {
  const { r, g, b } = hexToRgb(hex);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma < 14) return "neutral"; // grayscale

  const rn = r / 255,
    gn = g / 255,
    bn = b / 255;
  const maxN = Math.max(rn, gn, bn),
    minN = Math.min(rn, gn, bn);
  const l = (maxN + minN) / 2;
  const d = maxN - minN;
  const s = d === 0 ? 0 : l > 0.5 ? d / (2 - maxN - minN) : d / (maxN + minN);
  let h = 0;
  if (d !== 0) {
    if (maxN === rn) h = ((gn - bn) / d) % 6;
    else if (maxN === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }

  if (l < 0.22) return "brown"; // near-black browns
  if (s < 0.25) {
    if (l > 0.75) return "neutral";
    if (l < 0.45) return "brown";
    return "mauve"; // dusty rose/taupe territory
  }

  // Red-pink axis (wraps through 0).
  if (h >= 325 || h < 15) {
    if (l >= 0.72) return "pink";
    if (l >= 0.58) return s < 0.45 ? "nude" : "pink";
    if (l < 0.34) {
      if (h >= 348) return "red";
      return s >= 0.5 ? "berry" : "plum";
    }
    if (h >= 345 || h < 8) return "red";
    return s >= 0.5 ? "berry" : "plum";
  }
  // Orange/peach/coral.
  if (h < 42) {
    if (s < 0.45 && l < 0.55) return "brown";
    if (l >= 0.7) return h < 30 ? "peach" : "orange";
    if (h < 28) return "coral";
    return "orange";
  }
  if (h < 70) return l > 0.72 ? "peach" : "brown";
  if (h < 165) return "brown"; // olive/green, rare for makeup
  if (h < 260) return "plum"; // blue-purple
  if (h < 325) return "mauve"; // purple-pink
  return "red";
}

/** Human name for a shift between two swatches ("a touch deeper", "brighter on you"). */
export function describeShift(productHex: string, onFaceHex: string): string {
  const d = colorDistance(productHex, onFaceHex);
  const lp = luminance(productHex);
  const lf = luminance(onFaceHex);
  if (d / MAX_DISTANCE < 0.045) {
    return "True to the pan on you. We'll build from what's on your face.";
  }
  const deeper = lf < lp;
  const delta = Math.abs(lp - lf);
  const magnitude = delta < 0.06 ? "a touch" : delta < 0.18 ? "a step" : "a good deal";
  if (deeper) return `On you it reads like this: ${magnitude} deeper than the pan.`;
  return `On you it reads like this: ${magnitude} brighter than the pan.`;
}

/**
 * Nearest shade lookup when the render path cannot take an arbitrary hex.
 * distance() is the same metric used for the shift line.
 */
export function nearestShade<T extends { hex: string }>(target: string, shades: readonly T[]): T {
  let best = shades[0];
  if (!best) throw new Error("shades must be non-empty");
  let bestD = Infinity;
  for (const s of shades) {
    const d = colorDistance(target, s.hex);
    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }
  return best;
}
