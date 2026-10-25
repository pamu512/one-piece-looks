/**
 * Soft pigment masks for the coach face map (plan phase 2 step 3).
 *
 * Step 2 gave every zone fill a gaussian feather, but the edge was still
 * geometric: pigment landed on hair and background wherever a polygon
 * overlapped them, and no blur makes a polygon follow a hairline. A mask
 * intersects the feathered zone polygon with zll-bisenet probabilities
 * (lib/faceParse.ts):
 *
 *   mask alpha = zone coverage x class gate x occlusion gate
 *
 *   class gate     skin: ramp(p.skin, 0.35, 0.75); lip zones:
 *                  ramp(p.u_lip + p.l_lip, 0.35, 0.75) - the demo's ramp
 *   occlusion gate 1 - ramp(max(p.hair, p.bg), 0.45, 0.75) - hair and
 *                  background never glow
 *
 * The probability planes are lightly blurred first (demos/face-parsing/
 * demo.py's gaussian), so gate edges are as soft as the parse itself.
 * Gates are ramps, not argmax cuts, and the ramp tops out below typical
 * on-skin probability: the zone core keeps alpha 1, so step-2 pigment
 * strength and its probe margins carry over unchanged.
 *
 * Pure math down to buildMaskKit (no DOM): the mask algebra is
 * unit-testable. zoneMaskDataUrl is the raster bridge the overlay uses.
 */

import type { ParsePlanes } from "../faceParse.ts";

/** Which probability plane gates a zone's pigment. */
export type GateKind = "skin" | "lip";

/** ramp(lo, hi): 0 at/below lo, 1 at/above hi, linear between. */
export const SKIN_GATE: readonly [number, number] = [0.35, 0.75];
/** Same shape as the demo's lip ramp: clip((p12 + p13 - 0.35) / 0.4). */
export const LIP_GATE: readonly [number, number] = [0.35, 0.75];
/** Hair/background probability where suppression ramps 1 -> 0. */
export const OCC_GATE: readonly [number, number] = [0.45, 0.75];

/**
 * Box-blur radius (px on the parse grid) applied to the class planes
 * before gating - demo.py feathers with a gaussian of ~3 px at 512.
 */
export const GATE_BLUR_PX = 2;

/**
 * Linear ramp lo -> hi clamped to [0, 1]; NaN reads 0 (a broken
 * probability must not paint, and must not NaN the mask) while +/-Inf
 * saturate. Degenerate hi <= lo is a step at hi.
 */
export function ramp(x: number, lo: number, hi: number): number {
  if (Number.isNaN(x)) return 0;
  if (hi <= lo) return x >= hi ? 1 : 0;
  const t = (x - lo) / (hi - lo);
  return t < 0 ? 0 : t > 1 ? 1 : t;
}

export function skinGate(skin: number): number {
  return ramp(skin, SKIN_GATE[0]!, SKIN_GATE[1]!);
}

export function lipGate(lip: number): number {
  return ramp(lip, LIP_GATE[0]!, LIP_GATE[1]!);
}

export function occlusionGate(occ: number): number {
  return 1 - ramp(occ, OCC_GATE[0]!, OCC_GATE[1]!);
}

/**
 * Which gate a zone uses. Lip-color zones key off "lip" (none in the
 * current catalog; lipstick work is phase 3). Everything else - including
 * cupid_bow, whose highlight belongs on the skin just above the lip -
 * gates on skin.
 */
export function gateForZone(zoneId: string): GateKind {
  return zoneId.startsWith("lip") ? "lip" : "skin";
}

/* ---------- separable box blur, 3 passes ~ gaussian ---------- */

function clampI(x: number, size: number): number {
  return x < 0 ? 0 : x >= size ? size - 1 : x;
}

function boxPassH(src: Float32Array, size: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let y = 0; y < size; y++) {
    const row = y * size;
    let acc = 0;
    for (let x = -r; x <= r; x++) acc += src[row + clampI(x, size)]!;
    for (let x = 0; x < size; x++) {
      out[row + x] = acc / w;
      acc += src[row + clampI(x + r + 1, size)]! - src[row + clampI(x - r, size)]!;
    }
  }
  return out;
}

function boxPassV(src: Float32Array, size: number, r: number): Float32Array {
  const out = new Float32Array(src.length);
  const w = 2 * r + 1;
  for (let x = 0; x < size; x++) {
    let acc = 0;
    for (let y = -r; y <= r; y++) acc += src[clampI(y, size) * size + x]!;
    for (let y = 0; y < size; y++) {
      out[y * size + x] = acc / w;
      acc += src[clampI(y + r + 1, size) * size + x]! - src[clampI(y - r, size) * size + x]!;
    }
  }
  return out;
}

/**
 * Three box-blur passes (separable, clamp edges) approximate a gaussian
 * of sigma ~ r. Radius < 1 or a size-mismatched plane returns a copy.
 * Returns a new plane; the input is untouched.
 */
export function blurPlane(src: Float32Array, size: number, r: number): Float32Array {
  if (!(r >= 1) || !(size > 0) || src.length !== size * size) return src.slice();
  let cur = boxPassH(src, size, r);
  cur = boxPassV(cur, size, r);
  cur = boxPassH(cur, size, r);
  cur = boxPassV(cur, size, r);
  cur = boxPassH(cur, size, r);
  return boxPassV(cur, size, r);
}

/* ---------- mask assembly ---------- */

/** Pre-blurred planes shared by every zone mask for one photo. */
export interface MaskKit {
  size: number;
  skin: Float32Array;
  lip: Float32Array;
  occ: Float32Array;
}

/** Blur the class planes once per photo; every zone mask reuses these. */
export function buildMaskKit(planes: ParsePlanes, blurR: number = GATE_BLUR_PX): MaskKit {
  return {
    size: planes.size,
    skin: blurPlane(planes.skin, planes.size, blurR),
    lip: blurPlane(planes.lip, planes.size, blurR),
    occ: blurPlane(planes.occ, planes.size, blurR),
  };
}

/**
 * Mask alpha per pixel: zone coverage x class gate x occlusion gate,
 * clamped to [0, 1]. `zoneCoverage` is 0..1 on the kit's grid (the
 * feathered polygon raster); the result is the same shape. Values stay
 * within [0, coverage] so the mask can only remove pigment, never add.
 */
export function maskAlpha(zoneCoverage: Float32Array, kit: MaskKit, gate: GateKind): Float32Array {
  const n = kit.size * kit.size;
  const out = new Float32Array(n);
  const cls = gate === "lip" ? kit.lip : kit.skin;
  const clsGate = gate === "lip" ? lipGate : skinGate;
  for (let i = 0; i < n; i++) {
    const cov = zoneCoverage[i] ?? 0;
    if (!(cov > 0)) continue;
    const a = cov * clsGate(cls[i] ?? 0) * occlusionGate(kit.occ[i] ?? 0);
    out[i] = a > 1 ? 1 : a < 0 || !Number.isFinite(a) ? 0 : a;
  }
  return out;
}

/* ---------- raster bridge (DOM; pixel-probe covered) ---------- */

/** VB width the face map viewBox uses (coachOverlay's VB_W). */
export const MASK_VB_W = 1000;

/**
 * Rasterize one zone polygon (frame fractions) feathered by its step-2
 * sigma (viewBox units), intersect with the kit gates, and encode an SVG
 * mask image: white, alpha = mask value (an SVG mask's value is luminance
 * x alpha, so white with alpha a masks exactly a). The grid is the parse
 * grid: the photo is stretched onto it the same way the face map
 * stretches the photo to its viewBox, so polygon space, mask space, and
 * photo space agree. Null when the DOM is unavailable or the polygon is
 * degenerate - callers render the unmasked step-2 fill.
 */
export function zoneMaskDataUrl(
  poly: readonly { x: number; y: number }[],
  sigmaVb: number,
  kit: MaskKit,
  gate: GateKind,
  vbW: number = MASK_VB_W,
): string | null {
  if (typeof document === "undefined" || poly.length < 3) return null;
  const S = kit.size;
  const canvas = document.createElement("canvas");
  canvas.width = S;
  canvas.height = S;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const sigma = sigmaVb * (S / vbW);
  ctx.filter = Number.isFinite(sigma) && sigma > 0.05 ? `blur(${sigma.toFixed(2)}px)` : "none";
  ctx.fillStyle = "#ffffff";
  ctx.beginPath();
  for (let i = 0; i < poly.length; i++) {
    const p = poly[i]!;
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    if (i === 0) ctx.moveTo(p.x * S, p.y * S);
    else ctx.lineTo(p.x * S, p.y * S);
  }
  ctx.closePath();
  ctx.fill();
  ctx.filter = "none";

  let img: ImageData;
  try {
    img = ctx.getImageData(0, 0, S, S);
  } catch {
    return null;
  }
  const data = img.data;
  const cov = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) cov[i] = (data[i * 4 + 3] ?? 0) / 255;
  const alpha = maskAlpha(cov, kit, gate);
  for (let i = 0; i < S * S; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = Math.round((alpha[i] ?? 0) * 255);
  }
  ctx.putImageData(img, 0, 0);
  try {
    return canvas.toDataURL("image/png");
  } catch {
    return null;
  }
}
