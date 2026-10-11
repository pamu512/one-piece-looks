/**
 * Client-side shade derivation: the same color math as the server's
 * palettes() (apps/server/src/domain/builder.ts + color.ts), reimplemented
 * locally on purpose - the client never imports server code. Keeping the
 * formulas identical means the coached overlay and the final render agree
 * in color language (spec 5.3).
 *
 * All inputs/outputs are #RRGGBB.
 */

/** Server parity: clamp(n, lo, hi). */
export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

/** Server parity: hexToRgb on #RRGGBB. */
export function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const s = hex.replace("#", "");
  return {
    r: parseInt(s.slice(0, 2), 16),
    g: parseInt(s.slice(2, 4), 16),
    b: parseInt(s.slice(4, 6), 16),
  };
}

/** Server parity: rgbToHex. */
export function rgbToHex(r: number, g: number, b: number): string {
  const c = (n: number) => clamp(Math.round(n), 0, 255).toString(16).padStart(2, "0");
  return `#${c(r)}${c(g)}${c(b)}`.toLowerCase();
}

/** Server parity: sRGB relative luminance (0..1). */
export function luminance(hex: string): number {
  const { r, g, b } = hexToRgb(hex);
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

/** Server parity: linear mix, t=0 -> a, t=1 -> b. */
export function mix(a: string, b: string, t: number): string {
  const ca = hexToRgb(a);
  const cb = hexToRgb(b);
  const k = clamp(t, 0, 1);
  return rgbToHex(ca.r + (cb.r - ca.r) * k, ca.g + (cb.g - ca.g) * k, ca.b + (cb.b - ca.b) * k);
}

/** Server parity: HSL hue shift keeping S and L. */
export function shiftHue(hex: string, degrees: number): string {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255, gn = g / 255, bn = b / 255;
  const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  let h = 0, s = 0;
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
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const m = l - c / 2;
  let rr = 0, gg = 0, bb = 0;
  if (h < 60) [rr, gg, bb] = [c, x, 0];
  else if (h < 120) [rr, gg, bb] = [x, c, 0];
  else if (h < 180) [rr, gg, bb] = [0, c, x];
  else if (h < 240) [rr, gg, bb] = [0, x, c];
  else if (h < 300) [rr, gg, bb] = [x, 0, c];
  else [rr, gg, bb] = [c, 0, x];
  return rgbToHex((rr + m) * 255, (gg + m) * 255, (bb + m) * 255);
}

/** Lock hue families that bias the cheek shift (server classifyFamily subset). */
export type LockFamily =
  | "pink" | "berry" | "plum" | "mauve"
  | "peach" | "coral" | "orange"
  | "red" | "nude" | "brown" | "neutral";

/**
 * Server parity: classifyFamily(). The exact classifier from
 * apps/server/src/domain/color.ts, boundaries untouched - the cheek family
 * branch reads pink/berry/plum/mauve vs peach/coral/orange.
 */
export function classifyFamily(hex: string): LockFamily {
  const { r, g, b } = hexToRgb(hex);
  const chroma = Math.max(r, g, b) - Math.min(r, g, b);
  if (chroma < 14) return "neutral";

  const rn = r / 255, gn = g / 255, bn = b / 255;
  const maxN = Math.max(rn, gn, bn), minN = Math.min(rn, gn, bn);
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

  if (l < 0.22) return "brown";
  if (s < 0.25) {
    if (l > 0.75) return "neutral";
    if (l < 0.45) return "brown";
    return "mauve";
  }

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
  if (h < 42) {
    if (s < 0.45 && l < 0.55) return "brown";
    if (l >= 0.7) return h < 30 ? "peach" : "orange";
    if (h < 28) return "coral";
    return "orange";
  }
  if (h < 70) return l > 0.72 ? "peach" : "brown";
  if (h < 165) return "brown";
  if (h < 260) return "plum";
  if (h < 325) return "mauve";
  return "red";
}

/** Depth 0..1; either from the picker index or from skin luminance (server parity). */
export function depthOf(skinHex: string, pickerIndex?: number): number {
  if (pickerIndex !== undefined) return clamp(pickerIndex / 5, 0, 1);
  return clamp(1 - luminance(skinHex) * 1.15, 0, 1);
}

export interface CoachShades {
  skin: string;
  contour: string;
  highlight: string;
  brow: string;
  blush: string;
}

/**
 * The palettes() mirror (server builder.ts): same mix targets, same
 * coefficients, same cheek family shift.
 */
export function deriveShades(skinHex: string, lockHex: string, depth: number): CoachShades {
  const contour = mix(skinHex, "#5c3a28", 0.35 + depth * 0.2);
  const highlight = mix(skinHex, "#fff3e2", 0.4 - depth * 0.15);
  const brow = mix(skinHex, "#2f1c10", 0.55 + depth * 0.15);

  const family = classifyFamily(lockHex);
  const cheekBase =
    family === "pink" || family === "berry" || family === "plum" || family === "mauve"
      ? shiftHue(lockHex, -18)
      : family === "peach" || family === "coral" || family === "orange"
        ? shiftHue(lockHex, -8)
        : mix(lockHex, "#e8a598", 0.5);
  const blush = mix(cheekBase, skinHex, 0.15);

  return { skin: skinHex, contour, highlight, brow, blush };
}
