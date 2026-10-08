/**
 * Face compositor for mock mode: paints the VTO effect list onto the
 * session face photo.
 *
 * Soft lips + LAB support (lip-mass mask, 2026-10-08):
 *
 * Lips are their own stage after the LAB support layers. Coverage is
 * the client lip outline (parsing contour, or the redness fallback).
 * A class-11 lipInner is an evenodd hole, dilated after the blur so
 * the feather cannot paint teeth. No lipInner means no hole. The edge
 * is a 1 to 2 px erode and a 1 to 3 px blur that is not clipped back
 * to the hard outline. When lipMeanL/A/B are all present, one
 * encoded-LAB affine shifts the camera pixel so the lip mean moves
 * toward the product hex and per-pixel deviations stay. Role alpha
 * ramps Anchor, Lift, Statement. Missing means keep the color blend
 * and soft-light pass. Support layers still use the 0.06 face feather.
 *
 * Support layers (blush / brows / lashes / liner / shadow / veil) keep
 * the Soft LAB grade: landmark polygons, a face-scaled Gaussian mask,
 * then a LAB grade. L stays mostly the skin's; a/b move toward the
 * product hex. Eyes keep the thin lid shelf (no oval, no filled brow).
 * The lock hex stays #b3122e.
 *
 * Output is still a data-URL SVG. The browser runs the grade when it
 * rasterizes the image. Geometry is 1000x1250, matching the client 4:5 frame.
 */

import type { VtoEffect } from "./client.js";

export const CANVAS_W = 1000;
export const CANVAS_H = 1250;

export type FacePoly = ReadonlyArray<readonly [number, number]>;

export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

export interface FaceLandmarks {
  readonly faceBox?: FaceBox | undefined;
  readonly lip?: FacePoly | undefined;
  /** Class-11 mouth ring. When absent, the lip is painted with no hole. */
  readonly lipInner?: FacePoly | undefined;
  /** CIE L* of the lip flesh, 0..100. Mouth hole excluded. */
  readonly lipMeanL?: number | undefined;
  /** CIE a* of the lip flesh, -128..127. Mouth hole excluded. */
  readonly lipMeanA?: number | undefined;
  /** CIE b* of the lip flesh, -128..127. Mouth hole excluded. */
  readonly lipMeanB?: number | undefined;
  readonly eyeL?: FacePoly | undefined;
  readonly eyeR?: FacePoly | undefined;
  readonly browL?: FacePoly | undefined;
  readonly browR?: FacePoly | undefined;
  readonly cheekL?: FacePoly | undefined;
  readonly cheekR?: FacePoly | undefined;
}

interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface Stamp {
  points: Array<[number, number]>;
  hole?: Array<[number, number]> | undefined;
  /** inner = supplied lipInner that sits inside the outer lip. */
  holeKind?: "inner" | undefined;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

interface Zone {
  category: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  kind: "patch" | "lash" | "brow";
}

const ZONES: readonly Zone[] = [
  { category: "lip_color", cx: 500, cy: 848, rx: 118, ry: 58, kind: "patch" },
  { category: "blush", cx: 316, cy: 668, rx: 100, ry: 76, kind: "patch" },
  { category: "blush", cx: 684, cy: 668, rx: 100, ry: 76, kind: "patch" },
  { category: "eye_shadow", cx: 348, cy: 500, rx: 62, ry: 12, kind: "patch" },
  { category: "eye_shadow", cx: 652, cy: 500, rx: 62, ry: 12, kind: "patch" },
  { category: "eye_liner", cx: 348, cy: 492, rx: 58, ry: 4, kind: "lash" },
  { category: "eye_liner", cx: 652, cy: 492, rx: 58, ry: 4, kind: "lash" },
  { category: "eyebrows", cx: 340, cy: 442, rx: 52, ry: 4, kind: "brow" },
  { category: "eyebrows", cx: 660, cy: 442, rx: 52, ry: 4, kind: "brow" },
  { category: "eyelashes", cx: 348, cy: 496, rx: 56, ry: 4, kind: "lash" },
  { category: "eyelashes", cx: 652, cy: 496, rx: 56, ry: 4, kind: "lash" },
  { category: "contour", cx: 210, cy: 760, rx: 70, ry: 110, kind: "patch" },
  { category: "contour", cx: 790, cy: 760, rx: 70, ry: 110, kind: "patch" },
  { category: "highlighter", cx: 500, cy: 620, rx: 36, ry: 70, kind: "patch" },
];

const UNDER_VEIL = new Set(["blush", "contour", "highlighter", "eye_shadow"]);
// Lips composite after the veil in their own sRGB color-blend stage; they
// must not ride the LAB chain (blob/ring source, 2026-10-07).

const SUPPORT_PEAK: Record<string, number> = {
  lip_color: 0.86,
  blush: 0.66,
  eye_shadow: 0.48,
  eye_liner: 0.68,
  eyebrows: 0.48,
  eyelashes: 0.72,
  contour: 0.4,
  highlighter: 0.34,
};

const SUPPORT_CAP: Record<string, number> = {
  lip_color: 0.9,
  blush: 0.7,
  eye_shadow: 0.55,
  eye_liner: 0.75,
  eyebrows: 0.55,
  eyelashes: 0.8,
  contour: 0.5,
  highlighter: 0.4,
};

/** Brow / lash / liner read as powder on lift and statement, not a flat black stamp. */
const DEFINE_COLORS: Record<string, string> = {
  eyebrows: "#4a3226",
  eyelashes: "#241611",
  eye_liner: "#221510",
};

const VEIL_TINT = "#e6c0a8";

const XN = 0.95047;
const YN = 1;
const ZN = 1.08883;
const TABLE_N = 256;

function effectCategory(e: VtoEffect): string {
  return typeof e.category === "string" ? e.category : "";
}

function firstPalette(e: VtoEffect): Record<string, unknown> | null {
  if (!Array.isArray(e.palettes)) return null;
  const p = (e.palettes as unknown[])[0];
  return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
}

function effectColor(e: VtoEffect): string | null {
  const c = firstPalette(e)?.["color"];
  return typeof c === "string" ? c : null;
}

function colorIntensityOf(e: VtoEffect): number | undefined {
  const c = firstPalette(e)?.["colorIntensity"];
  return typeof c === "number" ? c : undefined;
}

function skinSmoothStrengthOf(e: VtoEffect): number | undefined {
  const s = (e as unknown as Record<string, unknown>)["skinSmoothStrength"];
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeHex(color: string): string | null {
  const m = /^#([0-9a-fA-F]{6})$/.exec(color.trim());
  return m ? `#${m[1]!.toLowerCase()}` : null;
}

function safeJpegB64(s: string): string {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) ? s : "";
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.min(1, Math.max(0, v));
}

function hexToRgb(hex: string): [number, number, number] | null {
  const safe = safeHex(hex);
  if (!safe) return null;
  const n = Number.parseInt(safe.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbHex(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

/** 0 at the floor, about 1 at a full statement. Same band the builder uses. */
export function intensityStretch(colorIntensity: number | undefined): number {
  if (typeof colorIntensity !== "number" || !Number.isFinite(colorIntensity)) return 0.6;
  const t = Math.max(0, Math.min(1.25, (colorIntensity - 30) / 40));
  return t < 0.7 ? t : 0.7 + (t - 0.7) * 2.6;
}

/** Mask alpha for one zone. Role scales it; the hex does not change. */
export function zoneAlpha(category: string, colorIntensity: number | undefined, role: string): number {
  const roleF = role === "statement" ? 1 : role === "lift" ? 0.74 : 0.46;
  const s = intensityStretch(colorIntensity);
  const peak = SUPPORT_PEAK[category] ?? 0.4;
  const cap = SUPPORT_CAP[category] ?? 0.55;
  const gain = 0.78 + Math.min(s, 1.3) * 0.22;
  const raw = peak * roleF * gain;
  if (!Number.isFinite(raw)) return 0;
  return Math.min(cap, Math.max(0, raw));
}

/** How far L moves toward the product. Shadow stays at 0.10. Lips skip this grade. */
export function zoneLightness(category: string): number {
  switch (category) {
    // lip_color never reaches the support LAB lerp. See lipStage.
    case "lip_color": return 0;
    case "eye_shadow": return 0.1;
    case "blush": return 0.2;
    case "eye_liner": return 0.5;
    case "eyelashes": return 0.35;
    case "eyebrows": return 0.16;
    case "contour": return 0.14;
    case "highlighter": return 0.18;
    default: return 0.2;
  }
}

function zoneGrow(category: string, colorIntensity: number | undefined, role: string): number {
  if (category !== "blush") return 1;
  const s = intensityStretch(colorIntensity);
  const roleK = role === "statement" ? 1.12 : role === "lift" ? 1.04 : 0.96;
  return roleK * (1.02 + Math.min(s, 1.3) * 0.12);
}

function veilStrength(smooth: number | undefined): { focus: number; tint: number } {
  if (typeof smooth !== "number" || !Number.isFinite(smooth) || smooth <= 0) return { focus: 0, tint: 0 };
  const focus = smooth <= 35
    ? Math.min(0.78, 0.06 + Math.max(0, smooth - 18) * 0.0411)
    : Math.min(0.88, 0.78 + (smooth - 35) * 0.0067);
  const tint = smooth <= 35
    ? Math.min(0.64, focus * 0.82)
    : Math.min(0.9, 0.64 + (smooth - 35) * 0.0173);
  return { focus, tint };
}

/* ---------- LAB ---------- */

function srgbToLin(u: number): number {
  const c = clamp01(u);
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linToSrgb(u: number): number {
  const c = clamp01(u);
  return c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055;
}

function labF(t: number): number {
  const c = clamp01(t);
  return c > 0.008856 ? Math.cbrt(c) : 7.787 * c + 16 / 116;
}

function labFInv(f: number): number {
  const c = clamp01(f);
  const d = 6 / 29;
  return c > d ? c * c * c : (c - 16 / 116) / 7.787;
}

function buildTable(fn: (u: number) => number): Float64Array {
  const t = new Float64Array(TABLE_N);
  for (let i = 0; i < TABLE_N; i++) t[i] = fn(i / (TABLE_N - 1));
  return t;
}

function tableText(t: Float64Array): string {
  const parts = new Array<string>(t.length);
  for (let i = 0; i < t.length; i++) parts[i] = t[i]!.toFixed(5);
  return parts.join(" ");
}

const LIN_TABLE = buildTable(srgbToLin);
const SRGB_TABLE = buildTable(linToSrgb);
const F_TABLE = buildTable(labF);
const FINV_TABLE = buildTable(labFInv);
const LIN_TEXT = tableText(LIN_TABLE);
const SRGB_TEXT = tableText(SRGB_TABLE);
const F_TEXT = tableText(F_TABLE);
const FINV_TEXT = tableText(FINV_TABLE);

function fmtMatrix(m: readonly number[]): string {
  return m.map((v) => v.toFixed(6)).join(" ");
}

function linToFMatrix(): number[] {
  const white = [XN, YN, ZN];
  const rgb = [
    [0.4124564, 0.3575761, 0.1804375],
    [0.2126729, 0.7151522, 0.0721750],
    [0.0193339, 0.1191920, 0.9503041],
  ];
  const m: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) m.push(rgb[row]![col]! / white[row]!);
    m.push(0, 0);
  }
  m.push(0, 0, 0, 1, 0);
  return m;
}

function fToLinMatrix(): number[] {
  const white = [XN, YN, ZN];
  const xyz = [
    [3.2404542, -1.5371385, -0.4985314],
    [-0.9692660, 1.8760108, 0.0415560],
    [0.0556434, -0.2040259, 1.0572252],
  ];
  const m: number[] = [];
  for (let row = 0; row < 3; row++) {
    for (let col = 0; col < 3; col++) m.push(xyz[row]![col]! * white[col]!);
    m.push(0, 0);
  }
  m.push(0, 0, 0, 1, 0);
  return m;
}

function encodeMatrix(): number[] {
  const eL = 116 / 100;
  const oL = -16 / 100;
  const eA = 500 / 255;
  const oA = 128 / 255;
  const eB = 200 / 255;
  const oB = 128 / 255;
  return [
    0, eL, 0, 0, oL,
    eA, -eA, 0, 0, oA,
    0, eB, -eB, 0, oB,
    0, 0, 0, 1, 0,
  ];
}

function decodeMatrix(): number[] {
  const a = 100 / 116;
  const b = 16 / 116;
  const cA = 255 / 500;
  const cB = 255 / 200;
  return [
    a, cA, 0, 0, b - 128 / 500,
    a, 0, 0, 0, b,
    a, 0, -cB, 0, b + 128 / 200,
    0, 0, 0, 1, 0,
  ];
}

const LIN_TO_F = linToFMatrix();
const F_TO_LIN = fToLinMatrix();
const ENCODE = encodeMatrix();
const DECODE = decodeMatrix();
const LIN_TO_F_TEXT = fmtMatrix(LIN_TO_F);
const F_TO_LIN_TEXT = fmtMatrix(F_TO_LIN);
const ENCODE_TEXT = fmtMatrix(ENCODE);
const DECODE_TEXT = fmtMatrix(DECODE);

/** First matrix coefficient string embedded in the SVG filter. */
export function labMatrixText(): string {
  return LIN_TO_F_TEXT;
}

function applyTable(u: number, table: Float64Array): number {
  const x = clamp01(u) * (table.length - 1);
  const i = Math.floor(x);
  const f = x - i;
  const a = table[i] ?? 0;
  const b = table[Math.min(table.length - 1, i + 1)] ?? a;
  return a * (1 - f) + b * f;
}

function applyMatrix(rgb: readonly [number, number, number], m: readonly number[]): [number, number, number] {
  const r = rgb[0], g = rgb[1], b = rgb[2];
  const dot = (row: number) => {
    const i = row * 5;
    return m[i]! * r + m[i + 1]! * g + m[i + 2]! * b + m[i + 3]! * 1 + m[i + 4]!;
  };
  return [clamp01(dot(0)), clamp01(dot(1)), clamp01(dot(2))];
}

function mapTable(rgb: readonly [number, number, number], table: Float64Array): [number, number, number] {
  return [applyTable(rgb[0], table), applyTable(rgb[1], table), applyTable(rgb[2], table)];
}

function encodeUnits(rgb255: readonly [number, number, number]): [number, number, number] {
  const u: [number, number, number] = [rgb255[0] / 255, rgb255[1] / 255, rgb255[2] / 255];
  const lin = mapTable(u, LIN_TABLE);
  const fIn = applyMatrix(lin, LIN_TO_F);
  const f = mapTable(fIn, F_TABLE);
  return applyMatrix(f, ENCODE);
}

function decodeUnits(enc: readonly [number, number, number]): [number, number, number] {
  const f = applyMatrix(enc, DECODE);
  const xyzN = mapTable(f, FINV_TABLE);
  const lin = applyMatrix(xyzN, F_TO_LIN);
  return mapTable(lin, SRGB_TABLE);
}

export interface Lab {
  L: number;
  a: number;
  b: number;
}

export function srgbToLab(r: number, g: number, b: number): Lab {
  const lin = (c: number) => {
    const s = clamp01(c / 255);
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / XN;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / YN;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / ZN;
  const fx = X > 0.008856 ? Math.cbrt(X) : 7.787 * X + 16 / 116;
  const fy = Y > 0.008856 ? Math.cbrt(Y) : 7.787 * Y + 16 / 116;
  const fz = Z > 0.008856 ? Math.cbrt(Z) : 7.787 * Z + 16 / 116;
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function labToSrgb(lab: Lab): [number, number, number] {
  const fy = (lab.L + 16) / 116;
  const fx = fy + lab.a / 500;
  const fz = fy - lab.b / 200;
  const finv = (f: number) => {
    const d = 6 / 29;
    return f > d ? f * f * f : (f - 16 / 116) / 7.787;
  };
  const X = finv(fx) * XN;
  const Y = finv(fy) * YN;
  const Z = finv(fz) * ZN;
  const R = 3.2404542 * X + -1.5371385 * Y + -0.4985314 * Z;
  const G = -0.9692660 * X + 1.8760108 * Y + 0.0415560 * Z;
  const B = 0.0556434 * X + -0.2040259 * Y + 1.0572252 * Z;
  const comp = (c: number) => Math.round(clamp01(linToSrgb(c)) * 255);
  return [comp(R), comp(G), comp(B)];
}

/** Spec lerp: a/b follow the mask, L follows mask * lightness. */
export function labLerp(skin: Lab, target: Lab, mask: number, lightness: number): Lab {
  const m = clamp01(mask);
  const k = clamp01(lightness);
  return {
    L: skin.L + (target.L - skin.L) * m * k,
    a: skin.a + (target.a - skin.a) * m,
    b: skin.b + (target.b - skin.b) * m,
  };
}

/**
 * Same grade the SVG filter applies (256-step tables, flood-quantized target).
 * mask 0 returns the round-trip of the skin, not a second composite.
 */
export function applySoftLab(
  skin: readonly [number, number, number],
  target: readonly [number, number, number],
  mask: number,
  lightness: number,
): [number, number, number] {
  const m = clamp01(mask);
  const k = clamp01(lightness);
  const sEnc = encodeUnits(skin);
  const tEnc = encodeUnits(target);
  const q: [number, number, number] = [
    Math.round(clamp01(tEnc[0]) * 255) / 255,
    Math.round(clamp01(tEnc[1]) * 255) / 255,
    Math.round(clamp01(tEnc[2]) * 255) / 255,
  ];
  const mixed: [number, number, number] = [
    sEnc[0] + (q[0] - sEnc[0]) * m * k,
    sEnc[1] + (q[1] - sEnc[1]) * m,
    sEnc[2] + (q[2] - sEnc[2]) * m,
  ];
  const out = decodeUnits(mixed);
  return [Math.round(out[0] * 255), Math.round(out[1] * 255), Math.round(out[2] * 255)];
}

function lipUnit(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return clamp01(c / 255);
}

function lipByte(u: number): number {
  if (!Number.isFinite(u)) return 0;
  return Math.round(clamp01(u) * 255);
}

/** W3C / feBlend luminosity. Same weights as compositing-1. */
function lipLum(c: readonly [number, number, number]): number {
  return 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];
}

function clipColor(c: [number, number, number]): [number, number, number] {
  let r0 = c[0], g0 = c[1], b0 = c[2];
  const l = lipLum([r0, g0, b0]);
  const n = Math.min(r0, g0, b0);
  if (n < 0) {
    const d = l - n;
    if (d === 0) return [l, l, l];
    r0 = l + ((r0 - l) * l) / d;
    g0 = l + ((g0 - l) * l) / d;
    b0 = l + ((b0 - l) * l) / d;
  }
  const x = Math.max(r0, g0, b0);
  if (x > 1) {
    const l2 = lipLum([r0, g0, b0]);
    const d = x - l2;
    if (d === 0) return [l2, l2, l2];
    return [
      l2 + ((r0 - l2) * (1 - l2)) / d,
      l2 + ((g0 - l2) * (1 - l2)) / d,
      l2 + ((b0 - l2) * (1 - l2)) / d,
    ];
  }
  return [r0, g0, b0];
}

function setLum(c: readonly [number, number, number], l: number): [number, number, number] {
  const d = l - lipLum(c);
  return clipColor([c[0] + d, c[1] + d, c[2] + d]);
}

/**
 * Share of the lip mix that stays on the color blend. The rest is
 * soft-light depth. 0.55 depth flattened camera luminance into the
 * blob/ring stamp (Statement, 2026-10-07).
 */
export const LIP_DEPTH = 0.18;
export const LIP_COLOR_KEEP = 0.82;
/** Skirt tightener on the blurred coverage mask. 1 stays 1; 0.35 collapses. */
export const LIP_MASK_GAMMA = 2.2;

/** W3C feBlend soft-light. Matches Banuba except Cb <= 0.25 and Cs > 0.5. */
function softLightChannel(cb: number, cs: number): number {
  if (cs <= 0.5) return cb - (1 - 2 * cs) * cb * (1 - cb);
  const d = cb <= 0.25 ? ((16 * cb - 12) * cb + 4) * cb : Math.sqrt(Math.max(0, cb));
  return cb + (2 * cs - 1) * (d - cb);
}

/**
 * Per-pixel lip mix the SVG filter applies: color blend, then
 * LIP_COLOR_KEEP / LIP_DEPTH with soft-light, then mask lerp.
 * depth defaults to LIP_DEPTH. Pass 0.55 to reproduce the flat stamp.
 */
export function applyLipComposite(
  base: readonly [number, number, number],
  lipstick: readonly [number, number, number],
  mask: number,
  depth = LIP_DEPTH,
): [number, number, number] {
  const m = clamp01(mask);
  const cb: [number, number, number] = [lipUnit(base[0]), lipUnit(base[1]), lipUnit(base[2])];
  if (m === 0) return [lipByte(cb[0]), lipByte(cb[1]), lipByte(cb[2])];
  const cs: [number, number, number] = [lipUnit(lipstick[0]), lipUnit(lipstick[1]), lipUnit(lipstick[2])];
  const colored = setLum(cs, lipLum(cb));
  const d = clamp01(depth);
  const mixed: [number, number, number] = [0, 1, 2].map((i) => {
    const soft = softLightChannel(colored[i]!, cs[i]!);
    return colored[i]! * (1 - d) + soft * d;
  }) as [number, number, number];
  return [0, 1, 2].map((i) => lipByte(cb[i]! * (1 - m) + mixed[i]! * m)) as [number, number, number];
}

/** L shift weight. Statement 0.60, Lift 0.55, Anchor 0.50. */
export function lipShiftK(role: string): number {
  if (role === "statement") return 0.6;
  if (role === "lift") return 0.55;
  return 0.5;
}

function shiftEncodedL(rgb: readonly [number, number, number], deltaL: number): [number, number, number] {
  if (deltaL === 0) return [rgb[0], rgb[1], rgb[2]];
  const enc = encodeUnits(rgb);
  const moved: [number, number, number] = [
    clamp01(enc[0] + deltaL / 100),
    enc[1],
    enc[2],
  ];
  const dec = decodeUnits(moved);
  return [dec[0] * 255, dec[1] * 255, dec[2] * 255];
}

/**
 * Lip pixel the SVG filter paints: color blend + soft-light, then
 * L' = L + k*(targetL - lipMeanL) on the painted pixel. mask 0 is the
 * unpainted camera pixel (the mouth hole). k comes from lipShiftK(role).
 */
export function applyLipTexture(
  base: readonly [number, number, number],
  lipstick: readonly [number, number, number],
  mask: number,
  lipMeanL: number | undefined,
  role: string,
  depth = LIP_DEPTH,
): [number, number, number] {
  const m = clamp01(mask);
  const orig = applyLipComposite(base, lipstick, 0, depth);
  if (m === 0) return orig;
  const painted = applyLipComposite(base, lipstick, 1, depth);
  const k = lipShiftK(role);
  const targetL = srgbToLab(lipstick[0] ?? 0, lipstick[1] ?? 0, lipstick[2] ?? 0).L;
  const delta = typeof lipMeanL === "number" && Number.isFinite(lipMeanL) && Number.isFinite(targetL)
    ? k * (targetL - lipMeanL)
    : 0;
  const shifted = delta === 0 ? painted : shiftEncodedL(painted, delta);
  return [0, 1, 2].map((i) => Math.round(orig[i]! * (1 - m) + shifted[i]! * m)) as [number, number, number];
}

/** Statement mean-shift weight. Role separation is the mask alpha, not this k. */
export const LIP_MEAN_SHIFT_K = 1;

export interface LipMeans {
  L: number;
  a: number;
  b: number;
}

function lipChannel(n: number | undefined, lo: number, hi: number): n is number {
  return typeof n === "number" && Number.isFinite(n) && n >= lo && n <= hi;
}

/** False can still be a LipMeans with a usable L, so this stays a boolean. */
export function lipMeansOk(means: LipMeans | undefined): boolean {
  return !!means && lipChannel(means.L, 0, 100) && lipChannel(means.a, -128, 127) && lipChannel(means.b, -128, 127);
}

/**
 * Encoded-LAB offsets for one mean-shift: R is L/100, G is (a+128)/255,
 * B is (b+128)/255. Same addition the feColorMatrix applies.
 */
export function lipMeanShiftDelta(
  lipstick: readonly [number, number, number],
  means: LipMeans,
  k = LIP_MEAN_SHIFT_K,
): { dL: number; dA: number; dB: number } | null {
  if (!lipMeansOk(means) || !Number.isFinite(k)) return null;
  if (![lipstick[0], lipstick[1], lipstick[2]].every((c) => Number.isFinite(c))) return null;
  const target = srgbToLab(lipstick[0] ?? 0, lipstick[1] ?? 0, lipstick[2] ?? 0);
  if (![target.L, target.a, target.b].every(Number.isFinite)) return null;
  return {
    dL: k * (target.L - means.L) / 100,
    dA: k * (target.a - means.a) / 255,
    dB: k * (target.b - means.b) / 255,
  };
}

function rgbByte(c: number): number {
  if (!Number.isFinite(c)) return 0;
  return Math.round(Math.min(255, Math.max(0, c)));
}

/**
 * JS mirror of the mean-shift lip stage. One encode, an affine in
 * encoded LAB, one decode, then lerp by the SVG mask
 * (coverage^gamma * role alpha). If a or b is missing, a valid L
 * still uses the color/soft-light L shift. colorIntensity defaults
 * to 80, the lock card's lip intensity.
 */
export function applyLipMeanShift(
  base: readonly [number, number, number],
  lipstick: readonly [number, number, number],
  coverage: number,
  means: LipMeans | undefined,
  role: string,
  colorIntensity = 80,
): [number, number, number] {
  const orig: [number, number, number] = [rgbByte(base[0] ?? 0), rgbByte(base[1] ?? 0), rgbByte(base[2] ?? 0)];
  const m = lipMaskAlpha(coverage, zoneAlpha("lip_color", colorIntensity, role));
  if (!lipMeansOk(means)) {
    const lOnly = means !== undefined && lipChannel(means.L, 0, 100) ? means.L : undefined;
    return applyLipTexture(orig, lipstick, m, lOnly, role);
  }
  if (m === 0) return orig;
  const delta = lipMeanShiftDelta(lipstick, means as LipMeans, LIP_MEAN_SHIFT_K);
  if (!delta) return applyLipTexture(orig, lipstick, m, (means as LipMeans).L, role);
  const enc = encodeUnits(orig);
  const moved: [number, number, number] = [
    clamp01(enc[0] + delta.dL),
    clamp01(enc[1] + delta.dA),
    clamp01(enc[2] + delta.dB),
  ];
  const dec = decodeUnits(moved);
  const shifted: [number, number, number] = [dec[0] * 255, dec[1] * 255, dec[2] * 255];
  return [0, 1, 2].map((i) => Math.round(orig[i]! * (1 - m) + shifted[i]! * m)) as [number, number, number];
}

/** Blurred coverage after the skirt gamma and the role alpha ramp. */
export function lipMaskAlpha(coverage: number, roleAlpha: number): number {
  const c = clamp01(coverage);
  const a = clamp01(roleAlpha);
  if (c === 0 || a === 0) return 0;
  return (c ** LIP_MASK_GAMMA) * a;
}

function floodFor(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "#808080";
  const enc = encodeUnits(rgb);
  return rgbHex(enc[0] * 255, enc[1] * 255, enc[2] * 255);
}

/* ---------- geometry ---------- */

/** Odd Gaussian kernel from inter-eye distance. Default frac is 0.06. */
export function oddFeatherKernel(interEyePx: number, frac = 0.06): number {
  const dist = Number.isFinite(interEyePx) && interEyePx > 1 ? interEyePx : 304;
  const f = Number.isFinite(frac) && frac > 0 ? frac : 0.06;
  let k = Math.round(dist * f);
  if (k < 3) k = 3;
  if (k % 2 === 0) k += 1;
  if (k > 151) k = 151;
  return k;
}

/** OpenCV default sigma for an odd kernel. Used as feGaussianBlur stdDeviation. */
export function featherSigma(kernel: number): number {
  const k = Number.isFinite(kernel) ? Math.max(3, kernel) : 3;
  return 0.3 * ((k - 1) * 0.5 - 1) + 0.8;
}

export function interEyePx(lm?: FaceLandmarks): number {
  const eyes = [lm?.eyeL, lm?.eyeR].filter((e): e is FacePoly => usablePoly(e));
  if (eyes.length === 2) {
    const a = centroid(toCanvas(eyes[0]!));
    const b = centroid(toCanvas(eyes[1]!));
    const d = Math.hypot(a[0] - b[0], a[1] - b[1]);
    if (d > 8) return d;
  }
  return 304;
}

function usablePoly(poly: FacePoly | undefined): poly is FacePoly {
  if (!poly || poly.length < 3) return false;
  for (const [x, y] of poly) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) return false;
    if (x < -0.25 || x > 1.25 || y < -0.25 || y > 1.25) return false;
  }
  return true;
}

function usableBox(f: FaceBox | undefined): f is FaceBox {
  if (!f) return false;
  return [f.x, f.y, f.w, f.h].every((n) => Number.isFinite(n))
    && f.w > 0.05 && f.h > 0.05 && f.w <= 1.2 && f.h <= 1.2;
}

function faceAxis(lm: FaceLandmarks | undefined): number {
  const f = lm?.faceBox;
  if (usableBox(f)) return (f.x + f.w / 2) * CANVAS_W;
  return CANVAS_W / 2;
}

function toCanvas(poly: FacePoly): Array<[number, number]> {
  return poly.map(([x, y]) => [x * CANVAS_W, y * CANVAS_H]);
}

function centroid(pts: ReadonlyArray<readonly [number, number]>): [number, number] {
  let sx = 0, sy = 0, n = 0;
  for (const [x, y] of pts) {
    if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
    sx += x; sy += y; n += 1;
  }
  if (n === 0) return [CANVAS_W / 2, CANVAS_H / 2];
  return [sx / n, sy / n];
}

function ellipseOf(pts: ReadonlyArray<readonly [number, number]>): Ellipse {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const [cx, cy] = centroid(pts);
  if (!Number.isFinite(minX)) return { cx, cy, rx: 6, ry: 4 };
  return { cx, cy, rx: Math.max(1, (maxX - minX) / 2), ry: Math.max(1, (maxY - minY) / 2) };
}

function stampFrom(
  points: Array<[number, number]>,
  hole?: Array<[number, number]>,
  holeKind?: Stamp["holeKind"],
): Stamp {
  const e = ellipseOf(points);
  return { points, hole, holeKind, cx: e.cx, cy: e.cy, rx: e.rx, ry: e.ry };
}

function smoothClosed(poly: ReadonlyArray<readonly [number, number]>, perSeg = 6): Array<[number, number]> {
  const n = poly.length;
  if (n < 3) return poly.map(([x, y]) => [x, y]);
  const pt = (i: number): readonly [number, number] => poly[((i % n) + n) % n]!;
  const out: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const p0 = pt(i - 1), p1 = pt(i), p2 = pt(i + 1), p3 = pt(i + 2);
    for (let j = 0; j < perSeg; j++) {
      const t = j / perSeg;
      const t2 = t * t;
      const t3 = t2 * t;
      const x = 0.5 * ((2 * p1[0]) + (-p0[0] + p2[0]) * t + (2 * p0[0] - 5 * p1[0] + 4 * p2[0] - p3[0]) * t2 + (-p0[0] + 3 * p1[0] - 3 * p2[0] + p3[0]) * t3);
      const y = 0.5 * ((2 * p1[1]) + (-p0[1] + p2[1]) * t + (2 * p0[1] - 5 * p1[1] + 4 * p2[1] - p3[1]) * t2 + (-p0[1] + 3 * p1[1] - 3 * p2[1] + p3[1]) * t3);
      if (Number.isFinite(x) && Number.isFinite(y)) out.push([x, y]);
    }
  }
  return out.length >= 3 ? out : poly.map(([x, y]) => [x, y]);
}

function pointInPoly(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if (!pi || !pj) continue;
    if ((pi[1] > y) === (pj[1] > y)) continue;
    const xHit = ((pj[0] - pi[0]) * (y - pi[1])) / (pj[1] - pi[1]) + pi[0];
    if (x < xHit) inside = !inside;
  }
  return inside;
}

function polyArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i]!, q = pts[(i + 1) % n]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return Math.abs(a) * 0.5;
}

function distToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
  const dx = bx - ax, dy = by - ay;
  const l2 = dx * dx + dy * dy;
  if (l2 === 0) return Math.hypot(px - ax, py - ay);
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / l2));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/**
 * A thin curved mouth gap is inside the lip when its area is a fraction
 * of the outer lip and its vertices sit in the outer polygon. Ellipse
 * rx/ry ratios reject that gap when the opening is almost as wide as
 * the vermillion. An inner ring that copies the outer lip still fails
 * the area cap, so it cannot stamp the whole mouth.
 */
function contained(x: number, y: number, outer: ReadonlyArray<readonly [number, number]>): boolean {
  if (pointInPoly(x, y, outer)) return true;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i]!, b = outer[(i + 1) % outer.length]!;
    if (distToSeg(x, y, a[0], a[1], b[0], b[1]) <= 1.5) return true;
  }
  return false;
}

function holeInside(
  outer: ReadonlyArray<readonly [number, number]>,
  hole: ReadonlyArray<readonly [number, number]>,
): boolean {
  if (outer.length < 3 || hole.length < 3) return false;
  const oa = polyArea(outer);
  const ha = polyArea(hole);
  if (!(oa > 1) || !(ha > 0.5) || ha >= oa * 0.55) return false;
  const [cx, cy] = centroid(hole);
  if (!contained(cx, cy, outer)) return false;
  let inside = 0;
  for (const [x, y] of hole) if (contained(x, y, outer)) inside += 1;
  return inside >= hole.length * 0.85;
}

/** A class-11 ring inside the lip. No ring, or a ring that fails the area test, means no hole. */
function lipHole(
  outer: Array<[number, number]>,
  inner: Array<[number, number]> | undefined,
): { pts: Array<[number, number]>; kind: "inner" } | null {
  if (inner && inner.length >= 3 && holeInside(outer, inner)) return { pts: inner, kind: "inner" };
  return null;
}

function refit(s: Stamp, to: Ellipse): Stamp {
  const rx = Math.max(1, s.rx);
  const ry = Math.max(1, s.ry);
  const map = (pts: Array<[number, number]>) => pts.map(([x, y]) => [
    to.cx + ((x - s.cx) / rx) * to.rx,
    to.cy + ((y - s.cy) / ry) * to.ry,
  ] as [number, number]);
  return { points: map(s.points), hole: s.hole ? map(s.hole) : undefined, holeKind: s.holeKind, cx: to.cx, cy: to.cy, rx: to.rx, ry: to.ry };
}

function shiftX(s: Stamp, dx: number): Stamp {
  if (dx === 0) return s;
  const map = (pts: Array<[number, number]>) => pts.map(([x, y]) => [x + dx, y] as [number, number]);
  return { points: map(s.points), hole: s.hole ? map(s.hole) : undefined, holeKind: s.holeKind, cx: s.cx + dx, cy: s.cy, rx: s.rx, ry: s.ry };
}

function mirrorPairs(
  zones: { ellipse: Ellipse }[],
  lm: FaceLandmarks | undefined,
): Ellipse[] {
  if (zones.length !== 2) return zones.map((z) => z.ellipse);
  const axis = faceAxis(lm);
  const [a, b] = zones[0]!.ellipse.cx <= zones[1]!.ellipse.cx ? [zones[0]!, zones[1]!] : [zones[1]!, zones[0]!];
  const rx = (a.ellipse.rx + b.ellipse.rx) / 2;
  const ry = (a.ellipse.ry + b.ellipse.ry) / 2;
  const cy = (a.ellipse.cy + b.ellipse.cy) / 2;
  const sameSide = (a.ellipse.cx - axis) * (b.ellipse.cx - axis) > 0;
  const left = sameSide
    ? { cx: a.ellipse.cx, cy, rx, ry }
    : { cx: axis - (Math.abs(axis - a.ellipse.cx) + Math.abs(axis - b.ellipse.cx)) / 2, cy, rx, ry };
  const right = sameSide
    ? { cx: b.ellipse.cx, cy, rx, ry }
    : { cx: axis + (Math.abs(axis - a.ellipse.cx) + Math.abs(axis - b.ellipse.cx)) / 2, cy, rx, ry };
  return [left, right];
}

function mirrorStamps(stamps: Stamp[], lm: FaceLandmarks | undefined): Stamp[] {
  if (stamps.length !== 2) return stamps;
  const sorted = stamps[0]!.cx <= stamps[1]!.cx ? [stamps[0]!, stamps[1]!] : [stamps[1]!, stamps[0]!];
  const placed = mirrorPairs(sorted.map((s) => ({ ellipse: { cx: s.cx, cy: s.cy, rx: s.rx, ry: s.ry } })), lm);
  return [refit(sorted[0]!, placed[0]!), refit(sorted[1]!, placed[1]!)];
}

function raiseCheek(pts: Array<[number, number]>, lm: FaceLandmarks | undefined): Array<[number, number]> {
  const el = ellipseOf(pts);
  const eyes = [lm?.eyeL, lm?.eyeR].filter((e): e is FacePoly => usablePoly(e)).map((p) => ellipseOf(toCanvas(p)));
  const eyeBottom = eyes.length > 0 ? Math.max(...eyes.map((e) => e.cy + e.ry)) : null;
  const raised = eyeBottom !== null ? eyeBottom + (el.cy - eyeBottom) * 0.42 : el.cy - el.ry * 0.2;
  const cy = Math.min(el.cy, raised);
  const dy = cy - el.cy;
  if (dy === 0) return pts;
  return pts.map(([x, y]) => [x, y + dy]);
}

/** Thin arch sitting on the upper lid. thick is the shelf height in px. */
function lidShelf(eye: ReadonlyArray<readonly [number, number]>, thickPx: number): Array<[number, number]> {
  const b = ellipseOf(eye);
  const top = b.cy - b.ry;
  const thick = Math.min(16, Math.max(4, thickPx));
  const rx = Math.max(8, b.rx);
  return [
    [b.cx - rx, top + thick * 0.2],
    [b.cx - rx * 0.35, top - thick * 0.75],
    [b.cx, top - thick],
    [b.cx + rx * 0.35, top - thick * 0.75],
    [b.cx + rx, top + thick * 0.2],
    [b.cx + rx * 0.5, top + thick * 0.45],
    [b.cx, top + thick * 0.55],
    [b.cx - rx * 0.5, top + thick * 0.45],
  ];
}

function lidBand(cx: number, cy: number, rx: number, thick: number): Array<[number, number]> {
  const top = cy - thick;
  return [
    [cx - rx, cy],
    [cx - rx * 0.35, top],
    [cx, top - thick * 0.15],
    [cx + rx * 0.35, top],
    [cx + rx, cy],
    [cx + rx * 0.45, cy + thick * 0.2],
    [cx, cy + thick * 0.28],
    [cx - rx * 0.45, cy + thick * 0.2],
  ];
}

function ribbon(pts: Array<[number, number]>, maxRy: number): Array<[number, number]> {
  const e = ellipseOf(pts);
  const k = e.ry > maxRy ? maxRy / e.ry : 1;
  return pts.map(([x, y]) => [x, e.cy + (y - e.cy) * k]);
}

function roundedPoly(cx: number, cy: number, rx: number, ry: number, n: number): Array<[number, number]> {
  const pts: Array<[number, number]> = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

function lipFallback(): Stamp {
  const cx = 500, cy = 848, rx = 118, ry = 52;
  const pts: Array<[number, number]> = [];
  const n = 24;
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    const upper = Math.sin(t) < 0;
    const bow = upper ? 0.86 + 0.14 * Math.max(0, Math.cos(2 * t)) : 1;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry * bow]);
  }
  const smooth = smoothClosed(pts, 3);
  return stampFrom(smooth);
}

function floorStamp(s: Stamp, minRx: number, minRy: number): Stamp {
  const kx = s.rx < minRx ? minRx / Math.max(1, s.rx) : 1;
  const ky = s.ry < minRy ? minRy / Math.max(1, s.ry) : 1;
  if (kx === 1 && ky === 1) return s;
  return refit(s, { cx: s.cx, cy: s.cy, rx: s.rx * kx, ry: s.ry * ky });
}

function fallbackStamps(category: string): Stamp[] {
  return ZONES.filter((z) => z.category === category).map((z) => {
    if (z.category === "lip_color") return lipFallback();
    if (z.category === "eye_shadow" || z.category === "eye_liner" || z.category === "eyelashes" || z.category === "eyebrows") {
      const thick = z.category === "eye_shadow" ? Math.min(z.ry, 14) : Math.min(z.ry, 5);
      return stampFrom(lidBand(z.cx, z.cy, z.rx, thick));
    }
    return stampFrom(roundedPoly(z.cx, z.cy, z.rx, z.ry, 16));
  });
}

function eyeStamps(eyes: Array<FacePoly | undefined>, thickOf: (eyeRy: number) => number): Stamp[] | null {
  const out: Stamp[] = [];
  for (const eye of eyes) {
    if (!usablePoly(eye)) continue;
    const canvas = toCanvas(eye);
    const ry = ellipseOf(canvas).ry;
    out.push(stampFrom(lidShelf(canvas, thickOf(ry))));
  }
  return out.length > 0 ? out : null;
}

function stampsFor(category: string, lm: FaceLandmarks | undefined): Stamp[] {
  switch (category) {
    case "lip_color": {
      const lip = lm?.lip;
      if (usablePoly(lip)) {
        // The client outline is the lip mass. Smoothing it bulges past the vermillion.
        const outer = toCanvas(lip);
        const inner = usablePoly(lm?.lipInner) ? toCanvas(lm!.lipInner!) : undefined;
        const hole = lipHole(outer, inner);
        return [hole ? stampFrom(outer, hole.pts, hole.kind) : stampFrom(outer)];
      }
      break;
    }
    case "blush": {
      const out: Stamp[] = [];
      const pushCheek = (poly: FacePoly) => {
        const raised = raiseCheek(toCanvas(poly), lm);
        const [cx, cy] = centroid(raised);
        const painted = stampFrom(smoothClosed(raised, 5));
        out.push({ ...painted, cx, cy });
      };
      const cheekL = lm?.cheekL;
      const cheekR = lm?.cheekR;
      if (usablePoly(cheekL)) pushCheek(cheekL);
      if (usablePoly(cheekR)) pushCheek(cheekR);
      if (out.length > 0) return mirrorStamps(out, lm);
      break;
    }
    case "eye_shadow": {
      const built = eyeStamps([lm?.eyeL, lm?.eyeR], (ry) => Math.min(14, Math.max(8, ry * 0.42)));
      if (built) return mirrorStamps(built, lm);
      break;
    }
    case "eye_liner":
    case "eyelashes": {
      const thick = category === "eye_liner" ? 5 : 6;
      const built = eyeStamps([lm?.eyeL, lm?.eyeR], () => thick);
      if (built) return mirrorStamps(built, lm);
      break;
    }
    case "eyebrows": {
      const out: Stamp[] = [];
      const brows = [lm?.browL, lm?.browR];
      const eyes = [lm?.eyeL, lm?.eyeR];
      for (let i = 0; i < 2; i++) {
        const b = brows[i];
        if (usablePoly(b)) {
          out.push(stampFrom(ribbon(smoothClosed(toCanvas(b), 4), 4.5)));
        } else if (usablePoly(eyes[i])) {
          const eye = ellipseOf(toCanvas(eyes[i]!));
          out.push(stampFrom(lidBand(eye.cx, eye.cy - eye.ry * 1.7, eye.rx * 1.05, 4)));
        }
      }
      if (out.length > 0) return mirrorStamps(out, lm);
      break;
    }
    case "contour":
    case "highlighter": {
      const f = lm?.faceBox;
      if (usableBox(f)) {
        if (category === "contour") {
          const cy = (f.y + f.h * 0.62) * CANVAS_H;
          const mk = (frac: number) => stampFrom(roundedPoly((f.x + f.w * frac) * CANVAS_W, cy, f.w * CANVAS_W * 0.08, f.h * CANVAS_H * 0.1, 12));
          return mirrorStamps([mk(0.14), mk(0.86)], lm);
        }
        return [stampFrom(roundedPoly((f.x + f.w / 2) * CANVAS_W, (f.y + f.h * 0.46) * CANVAS_H, f.w * CANVAS_W * 0.06, f.h * CANVAS_H * 0.08, 12))];
      }
      break;
    }
    default:
      break;
  }
  return fallbackStamps(category);
}

function finishStamps(
  category: string,
  stamps: Stamp[],
  grow: number,
  jitter: number,
  axis: number,
): Stamp[] {
  let next = stamps;
  if (category === "blush") {
    next = next.map((s) => floorStamp(s, 96, 70)).map((s) => (
      grow === 1 ? s : refit(s, { cx: s.cx, cy: s.cy, rx: s.rx * grow, ry: s.ry * grow })
    ));
  }
  if (jitter !== 0 && category !== "lip_color") {
    next = next.map((s) => shiftX(s, jitter * (s.cx > axis ? -1 : 1)));
  }
  return next;
}

function categoryJitterSeed(seed: number, effects: VtoEffect[]): number {
  let h = seed | 0;
  for (const e of effects) {
    const c = effectCategory(e);
    for (let i = 0; i < c.length; i++) {
      h ^= c.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return ((h >>> 0) % 7) - 3;
}

/* ---------- SVG ---------- */

function pathD(outer: ReadonlyArray<readonly [number, number]>, hole?: ReadonlyArray<readonly [number, number]>): string {
  const sub = (pts: ReadonlyArray<readonly [number, number]>): string => {
    if (pts.length < 3) return "";
    const head = `M ${pts[0]![0].toFixed(1)},${pts[0]![1].toFixed(1)}`;
    const rest = pts.slice(1).map(([x, y]) => `L ${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
    return `${head} ${rest} Z`;
  };
  const inner = hole && hole.length >= 3 ? ` ${sub(hole)}` : "";
  return `${sub(outer)}${inner}`;
}

interface Job {
  category: string;
  paint: string;
  alpha: number;
  lightness: number;
  sigma: number;
  kernel: number;
  stamps: Stamp[];
  falloff: boolean;
}

/** Lip-only job: the coverage mask + sRGB blend parameters. */
interface LipJob {
  paint: string;
  /** Mask alpha (role ramp). Anchor < Lift < Statement. */
  alpha: number;
  /** Feather stdDeviation in user units. Not the erode radius. */
  sigma: number;
  /** Same 3-decimal string as stdDeviation and data-sigma. */
  sigmaText: string;
  kernel: number;
  stamps: Stamp[];
  shiftK: number;
  /** Encoded-LAB offsets. a/b stay 0 on the color-blend fallback. */
  dL: number;
  dA: number;
  dB: number;
  /** All three means present: one affine, no color blend. */
  meanShift: boolean;
  lipMeanL: number | null;
  lipMeanA: number | null;
  lipMeanB: number | null;
}

function jobSvg(job: Job, id: string): string {
  const gradId = `g-${job.category}-${job.paint.slice(1)}`;
  const stops = job.falloff
    ? job.category === "blush"
      ? [[0, 1], [0.38, 0.7], [0.68, 0.28], [0.88, 0.06], [1, 0]]
      : [[0, 0.9], [0.45, 0.4], [0.8, 0.1], [1, 0]]
    : [];
  const grad = job.falloff
    ? `<defs><radialGradient id="${gradId}" cx="0.5" cy="${job.category === "blush" ? "0.38" : "0.5"}" r="0.96" gradientUnits="objectBoundingBox">${stops.map(([offset, op]) => `<stop offset="${offset}" stop-color="${job.paint}" stop-opacity="${(op ?? 0) === 0 ? "0" : (op ?? 0).toFixed(3)}"/>`).join("")}</radialGradient></defs>`
    : "";
  const paths = job.stamps.map((s) => {
    const fill = job.falloff ? `url(#${gradId})` : job.paint;
    const attrs = [
      `data-zone="${job.category}"`,
      `data-cx="${s.cx.toFixed(1)}"`,
      `data-cy="${s.cy.toFixed(1)}"`,
      `data-rx="${s.rx.toFixed(1)}"`,
      `data-ry="${s.ry.toFixed(1)}"`,
      `data-kernel="${job.kernel}"`,
      `data-sigma="${job.sigma.toFixed(3)}"`,
      `data-alpha="${job.alpha.toFixed(4)}"`,
      `data-lightness="${job.lightness.toFixed(3)}"`,
      `data-tint="${job.paint}"`,
      job.falloff ? `data-grad="${gradId}"` : "",
      `fill="${fill}"`,
      s.hole ? `fill-rule="evenodd"` : "",
    ].filter(Boolean).join(" ");
    return `<path ${attrs} d="${pathD(s.points, s.hole)}"/>`;
  }).join("");
  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">${grad}${paths}</svg>`;
}

/**
 * Lip coverage-mask document (white fill, evenodd hole). White keeps the
 * mask purely geometric: the blend stages read its alpha, not its color.
 */
function lipMaskSvg(job: LipJob, id: string): string {
  const paths = job.stamps.map((s) => {
    const attrs = [
      `data-zone="lip_color"`,
      `data-cx="${s.cx.toFixed(1)}"`,
      `data-cy="${s.cy.toFixed(1)}"`,
      `data-rx="${s.rx.toFixed(1)}"`,
      `data-ry="${s.ry.toFixed(1)}"`,
      `data-kernel="${job.kernel}"`,
      `data-sigma="${job.sigmaText}"`,
      `data-alpha="${job.alpha.toFixed(4)}"`,
      `data-tint="${job.paint}"`,
      `data-shift="${job.shiftK.toFixed(2)}"`,
      job.lipMeanL === null ? "" : `data-lmean="${job.lipMeanL.toFixed(2)}"`,
      job.lipMeanA === null ? "" : `data-amean="${job.lipMeanA.toFixed(2)}"`,
      job.lipMeanB === null ? "" : `data-bmean="${job.lipMeanB.toFixed(2)}"`,
      s.holeKind ? `data-hole="${s.holeKind}"` : "",
      `fill="#ffffff"`,
      s.hole ? `fill-rule="evenodd"` : "",
    ].filter(Boolean).join(" ");
    return `<path ${attrs} d="${pathD(s.points, s.hole)}"/>`;
  }).join("");
  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">${paths}</svg>`;
}

/** Hole-only mask. Dilated after the feather so the blur cannot paint the gap. */
function lipHoleSvg(job: LipJob, id: string): string {
  const paths = job.stamps.map((s) => {
    if (!s.hole || s.hole.length < 3) return "";
    return `<path fill="#ffffff" d="${pathD(s.hole)}"/>`;
  }).join("");
  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">${paths}</svg>`;
}

/** feColorMatrix offsets in encoded LAB. dL is on R, dA on G, dB on B. */
function labShiftMatrix(dL: number, dA: number, dB: number): string {
  const f = (n: number) => (Number.isFinite(n) ? n : 0).toFixed(6);
  return `1.000000 0.000000 0.000000 0.000000 ${f(dL)} 0.000000 1.000000 0.000000 0.000000 ${f(dA)} 0.000000 0.000000 1.000000 0.000000 ${f(dB)} 0.000000 0.000000 0.000000 1.000000 0.000000`;
}

function transfer(idIn: string, idOut: string, table: string): string {
  return `<feComponentTransfer in="${idIn}" result="${idOut}"><feFuncR type="table" tableValues="${table}"/><feFuncG type="table" tableValues="${table}"/><feFuncB type="table" tableValues="${table}"/><feFuncA type="identity"/></feComponentTransfer>`;
}

function matrix(idIn: string, idOut: string, values: string): string {
  return `<feColorMatrix in="${idIn}" result="${idOut}" type="matrix" values="${values}"/>`;
}

function encodeStep(p: string, src: string): { xml: string; out: string } {
  const out = `${p}en`;
  const xml = [
    transfer(src, `${p}ln`, LIN_TEXT),
    matrix(`${p}ln`, `${p}fi`, LIN_TO_F_TEXT),
    transfer(`${p}fi`, `${p}ff`, F_TEXT),
    matrix(`${p}ff`, out, ENCODE_TEXT),
  ].join("");
  return { xml, out };
}

function decodeStep(p: string, enc: string): { xml: string; out: string } {
  const out = `${p}px`;
  const xml = [
    matrix(enc, `${p}df`, DECODE_TEXT),
    transfer(`${p}df`, `${p}iv`, FINV_TEXT),
    matrix(`${p}iv`, `${p}rg`, F_TO_LIN_TEXT),
    transfer(`${p}rg`, out, SRGB_TEXT),
  ].join("");
  return { xml, out };
}

/** Lerp a/b by mask alpha and L by mask * lightness. Stays in encoded LAB. */
function lerpEncoded(p: string, enc: string, maskId: string, flood: string, alpha: number, lightness: number, sigma: number): { xml: string; out: string } {
  const out = `${p}o`;
  const xml = [
    `<feImage href="#${maskId}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="none" result="${p}sh"/>`,
    `<feGaussianBlur in="${p}sh" stdDeviation="${sigma.toFixed(3)}" result="${p}bl"/>`,
    `<feComponentTransfer in="${p}bl" result="${p}mk"><feFuncA type="linear" slope="${alpha.toFixed(4)}" intercept="0"/></feComponentTransfer>`,
    `<feFlood flood-color="${flood}" flood-opacity="1" result="${p}fl"/>`,
    `<feComposite in="${p}fl" in2="${p}mk" operator="in" result="${p}tm"/>`,
    `<feBlend in="${p}tm" in2="${enc}" mode="normal" result="${p}fu"/>`,
    `<feComponentTransfer in="${p}mk" result="${p}ml"><feFuncA type="linear" slope="${lightness.toFixed(4)}" intercept="0"/></feComponentTransfer>`,
    `<feComposite in="${p}fl" in2="${p}ml" operator="in" result="${p}tl"/>`,
    `<feBlend in="${p}tl" in2="${enc}" mode="normal" result="${p}lu"/>`,
    matrix(`${p}lu`, `${p}Lc`, "1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1"),
    matrix(`${p}fu`, `${p}Ac`, "0 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1"),
    `<feComposite in="${p}Lc" in2="${p}Ac" operator="arithmetic" k1="0" k2="1" k3="1" k4="0" result="${p}mg"/>`,
    matrix(`${p}mg`, out, "1 0 0 0 0 0 1 0 0 0 0 0 1 0 0 0 0 0 0 1"),
  ].join("");
  return { xml, out };
}

/**
 * Lip paint stage. Runs after every LAB support layer.
 *
 *   hard = lip outline, minus lipInner when that ring is present
 *   ramp = blur(erode(hard, 1..2px), feather 1..3px), not clipped to hard
 *   hole = dilate(lipInner) punched out of the ramp so teeth stay bare
 *   m = ramp ^ LIP_MASK_GAMMA * role alpha
 *   mean-shift (all three means): encode(camera) -> affine -> decode
 *     out = lerp(base, shifted, m)
 *   fallback (means missing): color blend, soft-light, optional L shift
 */
function lipStage(
  base: string,
  job: LipJob,
  maskId: string,
): { xml: string; out: string } {
  const p = "lp";
  const parts = [
    `<feImage href="#${maskId}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="none" result="${p}sh"/>`,
    `<feMorphology in="${p}sh" operator="erode" radius="${job.kernel}" result="${p}er"/>`,
    `<feGaussianBlur in="${p}er" stdDeviation="${job.sigmaText}" result="${p}bl"/>`,
  ];
  const hasHole = job.stamps.some((s) => s.hole && s.hole.length >= 3);
  if (hasHole) {
    const guard = Math.min(3, Math.max(1, Math.round(job.sigma)));
    parts.push(
      `<feImage href="#${maskId}h" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="none" result="${p}hh"/>`,
      `<feMorphology in="${p}hh" operator="dilate" radius="${guard}" result="${p}hd"/>`,
      `<feComposite in="${p}bl" in2="${p}hd" operator="out" result="${p}cl"/>`,
    );
  } else {
    parts.push(`<feOffset in="${p}bl" dx="0" dy="0" result="${p}cl"/>`);
  }
  parts.push(
    `<feComponentTransfer in="${p}cl" result="${p}gm"><feFuncA type="gamma" amplitude="1" exponent="${LIP_MASK_GAMMA.toFixed(3)}" offset="0"/></feComponentTransfer>`,
    `<feComponentTransfer in="${p}gm" result="${p}mk"><feFuncA type="linear" slope="${job.alpha.toFixed(4)}" intercept="0"/></feComponentTransfer>`,
  );
  let colored: string;
  if (job.meanShift) {
    const enc = encodeStep("lpe", base);
    parts.push(enc.xml);
    parts.push(matrix(enc.out, "lpes", labShiftMatrix(job.dL, job.dA, job.dB)));
    const dec = decodeStep("lpd", "lpes");
    parts.push(dec.xml);
    colored = dec.out;
  } else {
    parts.push(
      `<feFlood flood-color="${job.paint}" flood-opacity="1" result="${p}fl"/>`,
      `<feBlend in="${p}fl" in2="${base}" mode="color" result="${p}co"/>`,
      `<feBlend in="${p}fl" in2="${p}co" mode="soft-light" result="${p}sf"/>`,
      `<feComposite in="${p}co" in2="${p}sf" operator="arithmetic" k1="0" k2="${LIP_COLOR_KEEP.toFixed(4)}" k3="${LIP_DEPTH.toFixed(4)}" k4="0" result="${p}sl"/>`,
    );
    colored = `${p}sl`;
    if (job.dL !== 0) {
      const enc = encodeStep("lpe", colored);
      parts.push(enc.xml);
      parts.push(matrix(enc.out, "lpes", labShiftMatrix(job.dL, 0, 0)));
      const dec = decodeStep("lpd", "lpes");
      parts.push(dec.xml);
      colored = dec.out;
    }
  }
  parts.push(
    `<feComposite in="${colored}" in2="${p}mk" operator="in" result="${p}sd"/>`,
    `<feBlend in="${p}sd" in2="${base}" mode="normal" result="${p}out"/>`,
  );
  return { xml: parts.join(""), out: `${p}out` };
}

function veilMaskSvg(id: string, v: Ellipse): string {
  const x = (v.cx - v.rx).toFixed(1);
  const y = (v.cy - v.ry).toFixed(1);
  const w = (v.rx * 2).toFixed(1);
  const h = (v.ry * 2).toFixed(1);
  return `<svg id="${id}" xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}"><defs><radialGradient id="veilg" cx="0.5" cy="0.5" r="0.5" gradientUnits="objectBoundingBox"><stop offset="0" stop-color="#ffffff" stop-opacity="1"/><stop offset="0.72" stop-color="#ffffff" stop-opacity="1"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient></defs><rect x="${x}" y="${y}" width="${w}" height="${h}" fill="url(#veilg)"/></svg>`;
}

function veilSteps(srcPhoto: string, cur: string, maskId: string, focus: number, tint: number): { xml: string; out: string } {
  const parts = [`<feImage href="#${maskId}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="none" result="vsh"/>`];
  let name = cur;
  if (focus > 0) {
    parts.push(
      `<feGaussianBlur in="${srcPhoto}" stdDeviation="3.400" result="vbb"/>`,
      `<feComponentTransfer in="vsh" result="vfm"><feFuncA type="linear" slope="${focus.toFixed(4)}" intercept="0"/></feComponentTransfer>`,
      `<feComposite in="vbb" in2="vfm" operator="in" result="vbc"/>`,
      `<feBlend in="vbc" in2="${name}" mode="normal" result="vbf"/>`,
    );
    name = "vbf";
  }
  if (tint > 0) {
    parts.push(
      `<feFlood flood-color="${VEIL_TINT}" flood-opacity="1" result="vwc"/>`,
      `<feComponentTransfer in="vsh" result="vtm"><feFuncA type="linear" slope="${tint.toFixed(4)}" intercept="0"/></feComponentTransfer>`,
      `<feComposite in="vwc" in2="vtm" operator="in" result="vwt"/>`,
      `<feBlend in="vwt" in2="${name}" mode="multiply" result="veo"/>`,
    );
    name = "veo";
  }
  if (name === cur) parts.push(`<feOffset in="${cur}" dx="0" dy="0" result="veo"/>`);
  return { xml: parts.join(""), out: name === cur ? "veo" : name };
}

function buildJob(e: VtoEffect, role: string, lm: FaceLandmarks | undefined, jitter: number, kernel: number, sigma: number): Job | null {
  const category = effectCategory(e);
  if (!category || category === "skin_smooth" || category === "lip_color") return null;
  const color = effectColor(e);
  if (!color) return null;
  const chosen = role !== "anchor" && DEFINE_COLORS[category] ? DEFINE_COLORS[category]! : color;
  const paint = safeHex(chosen);
  if (!paint) return null;
  const alpha = zoneAlpha(category, colorIntensityOf(e), role);
  const lightness = zoneLightness(category);
  const grow = zoneGrow(category, colorIntensityOf(e), role);
  if (!Number.isFinite(alpha) || !Number.isFinite(lightness) || !Number.isFinite(grow) || alpha <= 0) return null;
  const stamps = finishStamps(category, stampsFor(category, lm), grow, jitter, faceAxis(lm));
  if (stamps.length === 0) return null;
  const falloff = category === "blush" || category === "contour" || category === "highlighter";
  return { category, paint, alpha, lightness, sigma, kernel, stamps, falloff };
}

/**
 * Erode radius is 1 or 2 px. Feather is 1 to 3 px, separate from that radius.
 * sigmaText is the 3-decimal string written to both stdDeviation and data-sigma.
 * It is toFixed of the unrounded ry. ry 37.49 yields 1.687; the 1-decimal
 * data-ry 37.5 yields 1.688, so the attribute is the wrong input.
 */
export function lipVermillionEdge(interEye: number, lipRy: number): { radius: number; sigma: number; sigmaText: string } {
  const dist = Number.isFinite(interEye) && interEye > 1 ? interEye : 304;
  const ry = Number.isFinite(lipRy) && lipRy > 1 ? lipRy : 40;
  const radius = ry < dist * 0.08 ? 1 : 2;
  const clamped = Math.min(3, Math.max(1, ry * 0.045));
  const sigmaText = clamped.toFixed(3);
  return { radius, sigma: Number(sigmaText), sigmaText };
}

/** ry is the unrounded stamp half-height the SVG sigma was computed from. */
export function lipPaintEdge(lm?: FaceLandmarks): { radius: number; sigma: number; sigmaText: string; ry: number } {
  const raw = finishStamps("lip_color", stampsFor("lip_color", lm), 1, 0, faceAxis(lm));
  const ry = raw.length > 0 ? Math.min(...raw.map((s) => s.ry)) : 40;
  return { ...lipVermillionEdge(interEyePx(lm), ry), ry };
}

/** Lips: redness outline, inward edge, alpha ramp unchanged. */
function buildLipJob(
  e: VtoEffect,
  role: string,
  lm: FaceLandmarks | undefined,
): LipJob | null {
  if (effectCategory(e) !== "lip_color") return null;
  const color = effectColor(e);
  if (!color) return null;
  const paint = safeHex(color);
  if (!paint) return null;
  const alpha = zoneAlpha("lip_color", colorIntensityOf(e), role);
  if (!Number.isFinite(alpha) || alpha <= 0) return null;
  const raw = finishStamps("lip_color", stampsFor("lip_color", lm), 1, 0, faceAxis(lm));
  if (raw.length === 0) return null;
  const ry = Math.min(...raw.map((s) => s.ry));
  const edge = lipVermillionEdge(interEyePx(lm), ry);
  const rgb = hexToRgb(paint);
  const meanLIn = lm?.lipMeanL;
  const meanAIn = lm?.lipMeanA;
  const meanBIn = lm?.lipMeanB;
  const means: LipMeans | undefined = lipChannel(meanLIn, 0, 100) && lipChannel(meanAIn, -128, 127) && lipChannel(meanBIn, -128, 127)
    ? { L: meanLIn, a: meanAIn, b: meanBIn }
    : undefined;
  const shifted = rgb && means ? lipMeanShiftDelta(rgb, means, LIP_MEAN_SHIFT_K) : null;
  const meanL = lipChannel(meanLIn, 0, 100) ? meanLIn : null;
  const fallbackK = lipShiftK(role);
  const targetL = rgb ? srgbToLab(rgb[0], rgb[1], rgb[2]).L : Number.NaN;
  const fallbackDL = !shifted && meanL !== null && Number.isFinite(targetL)
    ? fallbackK * (targetL - meanL) / 100
    : 0;
  return {
    paint,
    alpha,
    sigma: edge.sigma,
    sigmaText: edge.sigmaText,
    kernel: edge.radius,
    stamps: raw,
    shiftK: shifted ? LIP_MEAN_SHIFT_K : fallbackK,
    dL: shifted ? shifted.dL : fallbackDL,
    dA: shifted ? shifted.dA : 0,
    dB: shifted ? shifted.dB : 0,
    meanShift: shifted !== null,
    lipMeanL: meanL,
    lipMeanA: means ? means.a : null,
    lipMeanB: means ? means.b : null,
  };
}

export function faceCardSvg(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
  landmarks?: FaceLandmarks | undefined,
): string {
  const photo = safeJpegB64(facePhotoBase64);
  const eye = interEyePx(landmarks);
  const kernel = oddFeatherKernel(eye);
  const sigma = featherSigma(kernel);
  const jitter = categoryJitterSeed(seed, effects);
  let smooth = 0;
  for (const e of effects) {
    if (effectCategory(e) === "skin_smooth") {
      const s = skinSmoothStrengthOf(e);
      if (s !== undefined) smooth = Math.max(smooth, s);
    }
  }
  const jobs: Job[] = [];
  let lip: LipJob | null = null;
  for (const e of effects) {
    if (effectCategory(e) === "lip_color") {
      const lj = buildLipJob(e, role, landmarks);
      if (lj) lip = lj;
      continue;
    }
    const job = buildJob(e, role, landmarks, jitter, kernel, sigma);
    if (job) jobs.push(job);
  }
  const under = jobs.filter((j) => UNDER_VEIL.has(j.category));
  const over = jobs.filter((j) => !UNDER_VEIL.has(j.category));
  const veil = veilStrength(smooth);
  const f = landmarks?.faceBox;
  const veilBox: Ellipse = usableBox(f)
    ? { cx: (f.x + f.w / 2) * CANVAS_W, cy: (f.y + f.h / 2) * CANVAS_H, rx: f.w * CANVAS_W * 0.46, ry: f.h * CANVAS_H * 0.5 }
    : { cx: CANVAS_W / 2, cy: 470, rx: 300, ry: 430 };

  const defs: string[] = [];
  const prims: string[] = [`<feOffset in="SourceGraphic" dx="0" dy="0" result="src"/>`];
  const emitLab = (list: Job[], prefix: string, pix: string): string => {
    if (list.length === 0) return pix;
    const enc0 = encodeStep(`${prefix}e`, pix);
    prims.push(enc0.xml);
    let enc = enc0.out;
    list.forEach((job, i) => {
      const id = `${prefix}${i}`;
      defs.push(jobSvg(job, id));
      const step = lerpEncoded(id, enc, id, floodFor(job.paint), job.alpha, job.lightness, job.sigma);
      prims.push(step.xml);
      enc = step.out;
    });
    const dec = decodeStep(`${prefix}d`, enc);
    prims.push(dec.xml);
    return dec.out;
  };
  let pix = emitLab(under, "u", "src");
  if (veil.focus > 0 || veil.tint > 0) {
    defs.push(veilMaskSvg("vk", veilBox));
    const step = veilSteps("src", pix, "vk", veil.focus, veil.tint);
    prims.push(step.xml);
    pix = step.out;
  }
  pix = emitLab(over, "o", pix);
  if (lip) {
    defs.push(lipMaskSvg(lip, "lpm"));
    if (lip.stamps.some((s) => s.hole && s.hole.length >= 3)) defs.push(lipHoleSvg(lip, "lpmh"));
    const step = lipStage(pix, lip, "lpm");
    prims.push(step.xml);
    pix = step.out;
  }
  if (pix === "src" && prims.length === 1) {
    prims.push(`<feOffset in="src" dx="0" dy="0" result="src"/>`);
  }

  const filter = `<filter id="softlab" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" color-interpolation-filters="sRGB">${prims.join("")}</filter>`;
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    ${defs.join("\n    ")}
    ${filter}
  </defs>
  <image href="data:image/jpeg;base64,${photo}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="xMidYMid slice" filter="url(#softlab)"/>
</svg>`;
}

export function faceCardDataUrl(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
  landmarks?: FaceLandmarks | undefined,
): string {
  const svg = faceCardSvg(role, effects, seed, facePhotoBase64, landmarks);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
