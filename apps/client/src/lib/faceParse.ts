/**
 * BiSeNet face-parsing lips (CelebAMask-HQ, 19 classes) on a 512 crop.
 *
 * The redness polygon is the fallback. This module runs only from
 * detectFaceWithModel, once per capture, and any failure resolves null
 * so the heuristic lip stays. Classes: 11 mouth gap, 12 upper lip, 13 lower lip.
 *
 * Crop: square around the YOLO box, expanded so the face fills the middle
 * 50 to 60 percent of the side (CelebA-HQ framing). 512 input is required;
 * a 256 input or a full-frame parse drops the lips. Pixels outside the
 * frame are edge-replicated, not a new gray rectangle.
 *
 * Weights: apps/client/public/models/face-parse-bisenet-512-int8.onnx.
 * Non-commercial (CelebAMask-HQ). See docs/LICENSE-NOTES.md.
 */

import type { FaceBox, Poly } from "./face";

export const PARSE_SIZE = 512;
/** Face box's long side / crop side. 1/1.9 sits between 50 and 60 percent. */
export const CROP_EXPAND = 1.9;
/** Route sanitize drops a polygon longer than 80. Stay under that, and dense. */
export const LIP_POINT_COUNT = 64;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;
const CLASSES = 19;
const MOUTH = 11;
const UPPER_LIP = 12;
const LOWER_LIP = 13;
const LIP_RAMP_LO = 0.35;
const LIP_RAMP_SPAN = 0.4;
const ISO = 0.5;
/** Below this share of the crop the lip is noise. Above it the mask ate the face. */
const LIP_FRAC_MIN = 0.0005;
const LIP_FRAC_MAX = 0.08;
/**
 * Class 11 is a mouth hole only when its area is at least this fraction of
 * the lip polygon. Smaller gaps are closed lips: no hole is emitted.
 * The fraction is of area, so it does not depend on which face or crop size.
 */
export const LIP_INNER_MIN_FRAC = 0.04;

const MODEL_URL = "models/face-parse-bisenet-512-int8.onnx";

export interface SquareCrop {
  /** Top-left of the square in frame pixels. May be negative. */
  x: number;
  y: number;
  size: number;
}

export interface ParsedLips {
  lip: Array<[number, number]>;
  lipInner?: Array<[number, number]> | undefined;
  /** CIE L* of lip pixels (ramp >= 0.5), mouth gap excluded. */
  lipMeanL: number;
  /** CIE a* of those same pixels, -128..127. */
  lipMeanA: number;
  /** CIE b* of those same pixels, -128..127. */
  lipMeanB: number;
}

type OrtSession = import("onnxruntime-web").InferenceSession;
type OrtTensor = {
  data: ArrayLike<number>;
  dims: readonly number[];
  dispose?: () => void;
};

let sessionPromise: Promise<OrtSession | null> | null = null;

export function squareCropForBox(box: FaceBox, frameW: number, frameH: number): SquareCrop | null {
  if (!(frameW > 0 && frameH > 0)) return null;
  if (![box.x, box.y, box.w, box.h].every((n) => Number.isFinite(n))) return null;
  if (!(box.w > 0 && box.h > 0)) return null;
  const cx = (box.x + box.w / 2) * frameW;
  const cy = (box.y + box.h / 2) * frameH;
  const side = Math.max(box.w * frameW, box.h * frameH) * CROP_EXPAND;
  if (!(side > 1)) return null;
  return { x: cx - side / 2, y: cy - side / 2, size: side };
}

/** Pixel-index space: integer gx is the center of parse pixel gx. */
export function framePxToGrid(px: number, py: number, crop: SquareCrop, size = PARSE_SIZE): [number, number] {
  return [
    ((px - crop.x) / crop.size) * size - 0.5,
    ((py - crop.y) / crop.size) * size - 0.5,
  ];
}

export function gridToFrameNorm(
  gx: number,
  gy: number,
  crop: SquareCrop,
  frameW: number,
  frameH: number,
  size = PARSE_SIZE,
): [number, number] {
  const px = crop.x + ((gx + 0.5) / size) * crop.size;
  const py = crop.y + ((gy + 0.5) / size) * crop.size;
  return [px / frameW, py / frameH];
}

/** Bilinear RGB. Coordinates outside the frame clamp to the edge pixel. */
export function sampleRgbEdge(
  rgba: Uint8ClampedArray,
  w: number,
  h: number,
  x: number,
  y: number,
): [number, number, number] {
  if (!(w > 0 && h > 0)) return [0, 0, 0];
  const cx = Math.max(0, Math.min(w - 1, x));
  const cy = Math.max(0, Math.min(h - 1, y));
  const x0 = Math.floor(cx);
  const y0 = Math.floor(cy);
  const x1 = Math.min(w - 1, x0 + 1);
  const y1 = Math.min(h - 1, y0 + 1);
  const tx = cx - x0;
  const ty = cy - y0;
  const at = (px: number, py: number, ch: number): number => rgba[(py * w + px) * 4 + ch] ?? 0;
  const mix = (ch: number): number => {
    const top = at(x0, y0, ch) * (1 - tx) + at(x1, y0, ch) * tx;
    const bot = at(x0, y1, ch) * (1 - tx) + at(x1, y1, ch) * tx;
    return top * (1 - ty) + bot * ty;
  };
  return [mix(0), mix(1), mix(2)];
}

/** RGB 0..255 frame to NCHW float32, ImageNet mean/std, bilinear into `size`. */
export function cropToNchw(
  rgba: Uint8ClampedArray,
  frameW: number,
  frameH: number,
  crop: SquareCrop,
  size = PARSE_SIZE,
): Float32Array {
  const data = new Float32Array(3 * size * size);
  const plane = size * size;
  for (let y = 0; y < size; y++) {
    const sy = crop.y + ((y + 0.5) / size) * crop.size;
    for (let x = 0; x < size; x++) {
      const sx = crop.x + ((x + 0.5) / size) * crop.size;
      const [r, g, b] = sampleRgbEdge(rgba, frameW, frameH, sx, sy);
      const i = y * size + x;
      data[i] = (r / 255 - MEAN[0]) / STD[0];
      data[plane + i] = (g / 255 - MEAN[1]) / STD[1];
      data[2 * plane + i] = (b / 255 - MEAN[2]) / STD[2];
    }
  }
  return data;
}

/** Stable softmax over class-major logits [classes, n]. */
export function softmaxClassMajor(logits: Float32Array, classes: number, n: number): Float32Array {
  const out = new Float32Array(classes * n);
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let c = 0; c < classes; c++) {
      const v = logits[c * n + i] ?? -Infinity;
      if (v > max) max = v;
    }
    let sum = 0;
    for (let c = 0; c < classes; c++) {
      const e = Math.exp((logits[c * n + i] ?? 0) - max);
      out[c * n + i] = e;
      sum += e;
    }
    const inv = sum > 0 ? 1 / sum : 0;
    for (let c = 0; c < classes; c++) out[c * n + i] = (out[c * n + i] ?? 0) * inv;
  }
  return out;
}

const LAB_XN = 0.95047;
const LAB_YN = 1;
const LAB_ZN = 1.08883;

export interface CieLab {
  L: number;
  a: number;
  b: number;
}

/** D65 Lab, same matrices as the server srgbToLab. */
export function cieLab(r: number, g: number, b: number): CieLab {
  const lin = (c: number): number => {
    const s = Math.max(0, Math.min(1, c / 255));
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / LAB_XN;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / LAB_YN;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / LAB_ZN;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function cieL(r: number, g: number, b: number): number {
  return cieLab(r, g, b).L;
}

function clampLipMean(lab: CieLab): CieLab {
  return {
    L: Math.min(100, Math.max(0, lab.L)),
    a: Math.min(127, Math.max(-128, lab.a)),
    b: Math.min(127, Math.max(-128, lab.b)),
  };
}

export function pointInPoly(x: number, y: number, poly: ReadonlyArray<readonly [number, number]>): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (!pi || !pj) continue;
    const yi = pi[1], yj = pj[1];
    if ((yi > y) === (yj > y)) continue;
    const xi = pi[0], xj = pj[0];
    const xHit = ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (x < xHit) inside = !inside;
  }
  return inside;
}

/** BiSeNet logits are float32 [1, 19, 512, 512]. Anything else is a bad graph. */
export function logitsVolumeOk(dims: readonly number[], dataLength: number): boolean {
  if (dims.length < 4) return false;
  const batch = Number(dims[0]);
  const classes = Number(dims[1]);
  const h = Number(dims[2]);
  const w = Number(dims[3]);
  const n = CLASSES * PARSE_SIZE * PARSE_SIZE;
  return batch === 1 && classes === CLASSES && h === PARSE_SIZE && w === PARSE_SIZE && dataLength >= n;
}

/** Copy model logits. A non-finite value means the run failed; the caller keeps the heuristic. */
export function copyLogits(data: ArrayLike<number>, n: number): Float32Array | null {
  if (!(n > 0) || data.length < n) return null;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = data[i] ?? Number.NaN;
    if (!Number.isFinite(v)) return null;
    out[i] = v;
  }
  return out;
}

export function lipFractionPlausible(lipPx: number, gridPx: number): boolean {
  if (!(gridPx > 0) || !(lipPx >= 1)) return false;
  const f = lipPx / gridPx;
  return f >= LIP_FRAC_MIN && f <= LIP_FRAC_MAX;
}

/**
 * Mean CIE Lab inside `lip` and outside `hole`. `rgbAt` is frame pixels.
 * Returns null when fewer than 8 flesh samples survive.
 */
export function meanLipFleshLab(
  frameW: number,
  frameH: number,
  rgbAt: (x: number, y: number) => readonly [number, number, number],
  lip: ReadonlyArray<readonly [number, number]>,
  hole: ReadonlyArray<readonly [number, number]> | undefined,
): CieLab | null {
  if (lip.length < 3 || !(frameW > 0 && frameH > 0)) return null;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const [x, y] of lip) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX * frameW));
  const y0 = Math.max(0, Math.floor(minY * frameH));
  const x1 = Math.min(frameW - 1, Math.ceil(maxX * frameW));
  const y1 = Math.min(frameH - 1, Math.ceil(maxY * frameH));
  const skipHole = hole !== undefined && hole.length >= 3;
  let sumL = 0, sumA = 0, sumB = 0, n = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const nx = x / frameW, ny = y / frameH;
      if (!pointInPoly(nx, ny, lip)) continue;
      if (skipHole && pointInPoly(nx, ny, hole)) continue;
      const [r, g, b] = rgbAt(x, y);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      const lab = cieLab(r, g, b);
      sumL += lab.L;
      sumA += lab.a;
      sumB += lab.b;
      n += 1;
    }
  }
  if (n < 8) return null;
  const mean = { L: sumL / n, a: sumA / n, b: sumB / n };
  if (![mean.L, mean.a, mean.b].every(Number.isFinite)) return null;
  return clampLipMean(mean);
}

export function meanLipFleshL(
  frameW: number,
  frameH: number,
  rgbAt: (x: number, y: number) => readonly [number, number, number],
  lip: ReadonlyArray<readonly [number, number]>,
  hole: ReadonlyArray<readonly [number, number]> | undefined,
): number | null {
  return meanLipFleshLab(frameW, frameH, rgbAt, lip, hole)?.L ?? null;
}

function rampLip(lipP: number): number {
  return Math.min(1, Math.max(0, (lipP - LIP_RAMP_LO) / LIP_RAMP_SPAN));
}

function largestComponent(field: Float32Array, size: number, thr: number): Float32Array {
  const n = size * size;
  const label = new Int32Array(n);
  label.fill(-1);
  const out = new Float32Array(n);
  let next = 0, bestLabel = -1, bestCount = 0;
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    if (label[i] !== -1 || (field[i] ?? 0) < thr) continue;
    const id = next++;
    stack.length = 0;
    stack.push(i);
    label[i] = id;
    let count = 0;
    while (stack.length > 0) {
      const p = stack.pop()!;
      count += 1;
      const x = p % size;
      const y = (p - x) / size;
      const push = (q: number): void => {
        if (label[q] !== -1 || (field[q] ?? 0) < thr) return;
        label[q] = id;
        stack.push(q);
      };
      if (x > 0) push(p - 1);
      if (x + 1 < size) push(p + 1);
      if (y > 0) push(p - size);
      if (y + 1 < size) push(p + size);
    }
    if (count > bestCount) {
      bestCount = count;
      bestLabel = id;
    }
  }
  if (bestLabel < 0) return out;
  for (let i = 0; i < n; i++) if (label[i] === bestLabel) out[i] = field[i] ?? 0;
  return out;
}

type Pt = [number, number];

function lerpEdge(x0: number, y0: number, v0: number, x1: number, y1: number, v1: number, thr: number): Pt {
  const d = v1 - v0;
  const u = d === 0 ? 0.5 : (thr - v0) / d;
  const t = Math.min(1, Math.max(0, u));
  return [x0 + (x1 - x0) * t, y0 + (y1 - y0) * t];
}

/** Edge ids: 0 top, 1 right, 2 bottom, 3 left. Saddle uses the cell center. */
function segmentPairs(mask: number, centerOn: boolean): Array<[number, number]> {
  switch (mask) {
    case 1: return [[3, 0]];
    case 2: return [[0, 1]];
    case 3: return [[3, 1]];
    case 4: return [[1, 2]];
    case 5: return centerOn ? [[3, 2], [0, 1]] : [[3, 0], [1, 2]];
    case 6: return [[0, 2]];
    case 7: return [[3, 2]];
    case 8: return [[2, 3]];
    case 9: return [[2, 0]];
    case 10: return centerOn ? [[0, 3], [1, 2]] : [[0, 1], [2, 3]];
    case 11: return [[2, 1]];
    case 12: return [[1, 3]];
    case 13: return [[1, 0]];
    case 14: return [[0, 3]];
    default: return [];
  }
}

function ptKey(p: Pt): string {
  return `${p[0].toFixed(3)},${p[1].toFixed(3)}`;
}

function shoelace(poly: readonly Pt[]): number {
  let a = 0;
  for (let i = 0, n = poly.length; i < n; i++) {
    const j = (i + 1) % n;
    const p = poly[i]!, q = poly[j]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a * 0.5;
}

function chaikinClosed(poly: readonly Pt[]): Pt[] {
  const n = poly.length;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
    out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
  }
  return out;
}

function resampleClosed(poly: readonly Pt[], count: number): Pt[] | null {
  const n = poly.length;
  if (n < 3 || count < 3) return null;
  const seg = new Array<number>(n);
  let total = 0;
  for (let i = 0; i < n; i++) {
    const a = poly[i]!, b = poly[(i + 1) % n]!;
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    seg[i] = d;
    total += d;
  }
  if (!(total > 0)) return null;
  const out: Pt[] = [];
  for (let k = 0; k < count; k++) {
    let dist = (k / count) * total;
    let i = 0;
    while (i < n && dist > (seg[i] ?? 0)) {
      dist -= seg[i] ?? 0;
      i += 1;
    }
    if (i >= n) i = n - 1;
    const a = poly[i]!;
    const b = poly[(i + 1) % n]!;
    const d = seg[i] ?? 0;
    const t = d > 0 ? dist / d : 0;
    out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
  }
  return out;
}

/** 0.5 iso-contour of the largest loop, smoothed, resampled to LIP_POINT_COUNT. */
function traceIso(field: Float32Array, size: number, thr: number): Pt[] | null {
  // Zero halo: a component that touches the crop edge still has a closed loop.
  const ps = size + 2;
  const padded = new Float32Array(ps * ps);
  for (let y = 0; y < size; y++) {
    padded.set(field.subarray(y * size, y * size + size), (y + 1) * ps + 1);
  }
  const segs: Array<[Pt, Pt]> = [];
  for (let y = 0; y < ps - 1; y++) {
    const row = y * ps;
    const next = row + ps;
    for (let x = 0; x < ps - 1; x++) {
      const v00 = padded[row + x] ?? 0;
      const v10 = padded[row + x + 1] ?? 0;
      const v11 = padded[next + x + 1] ?? 0;
      const v01 = padded[next + x] ?? 0;
      let mask = 0;
      if (v00 >= thr) mask |= 1;
      if (v10 >= thr) mask |= 2;
      if (v11 >= thr) mask |= 4;
      if (v01 >= thr) mask |= 8;
      if (mask === 0 || mask === 15) continue;
      const centerOn = (v00 + v10 + v11 + v01) / 4 >= thr;
      const edge = (id: number): Pt => {
        if (id === 0) return lerpEdge(x, y, v00, x + 1, y, v10, thr);
        if (id === 1) return lerpEdge(x + 1, y, v10, x + 1, y + 1, v11, thr);
        if (id === 2) return lerpEdge(x, y + 1, v01, x + 1, y + 1, v11, thr);
        return lerpEdge(x, y, v00, x, y + 1, v01, thr);
      };
      for (const [a, b] of segmentPairs(mask, centerOn)) segs.push([edge(a), edge(b)]);
    }
  }
  if (segs.length === 0) return null;
  const unused = new Set<number>();
  const adj = new Map<string, number[]>();
  const link = (k: string, i: number): void => {
    const list = adj.get(k);
    if (list) list.push(i);
    else adj.set(k, [i]);
  };
  for (let i = 0; i < segs.length; i++) {
    unused.add(i);
    const s = segs[i]!;
    link(ptKey(s[0]), i);
    link(ptKey(s[1]), i);
  }
  let best: Pt[] | null = null;
  let bestArea = 0;
  while (unused.size > 0) {
    const start = unused.values().next().value as number;
    unused.delete(start);
    const first = segs[start]!;
    const loop: Pt[] = [first[0], first[1]];
    for (let guard = 0; guard < segs.length + 2; guard++) {
      const end = loop[loop.length - 1]!;
      if (loop.length > 3 && ptKey(end) === ptKey(loop[0]!)) break;
      const cands = adj.get(ptKey(end));
      let next = -1;
      if (cands) {
        for (const i of cands) if (unused.has(i)) { next = i; break; }
      }
      if (next < 0) break;
      unused.delete(next);
      const s = segs[next]!;
      loop.push(ptKey(s[0]) === ptKey(end) ? s[1] : s[0]);
    }
    if (loop.length > 4 && ptKey(loop[0]!) === ptKey(loop[loop.length - 1]!)) {
      loop.pop();
      const area = Math.abs(shoelace(loop));
      if (area > bestArea) {
        bestArea = area;
        best = loop;
      }
    }
  }
  if (!best || best.length < 8) return null;
  const shifted = best.map(([x, y]) => [x - 1, y - 1] as Pt);
  const smooth = chaikinClosed(chaikinClosed(shifted));
  return resampleClosed(smooth, LIP_POINT_COUNT);
}

/**
 * True when the hole polygon covers lip flesh, not only a one-pixel smoothing sliver.
 * A ring of class 11 traces an outer loop whose interior is still vermillion.
 */
function coversLipFlesh(
  hole: readonly Pt[],
  ramp: Float32Array,
  mouth: Float32Array,
  size: number,
): boolean {
  if (hole.length < 3) return false;
  let minX = size, minY = size, maxX = 0, maxY = 0;
  for (const [x, y] of hole) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(size - 1, Math.ceil(maxX));
  const y1 = Math.min(size - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    const row = y * size;
    for (let x = x0; x <= x1; x++) {
      const i = row + x;
      if ((ramp[i] ?? 0) < ISO || (mouth[i] ?? 0) >= ISO) continue;
      if (!pointInPoly(x, y, hole)) continue;
      if (
        pointInPoly(x - 1, y, hole) &&
        pointInPoly(x + 1, y, hole) &&
        pointInPoly(x, y - 1, hole) &&
        pointInPoly(x, y + 1, hole)
      ) return true;
    }
  }
  return false;
}

function clampWire(p: readonly [number, number]): [number, number] {
  return [
    Math.min(1.05, Math.max(-0.05, p[0])),
    Math.min(1.05, Math.max(-0.05, p[1])),
  ];
}

function mostlyInside(poly: readonly Pt[], outer: readonly Pt[]): boolean {
  if (outer.length < 3 || poly.length < 3) return false;
  let n = 0;
  for (const [x, y] of poly) if (pointInPoly(x, y, outer)) n += 1;
  return n >= poly.length * 0.85;
}

/**
 * Build lip / lipInner / lip means from a class-major probability volume.
 * `probs` is [19, size*size]. Closed mouths (no class 11, or a class-11
 * area under LIP_INNER_MIN_FRAC of the lip) omit lipInner. A mouth
 * contour that covers lip pixels is dropped rather than punched through them.
 */
export function lipsFromClassProbs(
  probs: Float32Array,
  size: number,
  crop: SquareCrop,
  frameW: number,
  frameH: number,
  rgbAt: (gx: number, gy: number) => readonly [number, number, number],
): ParsedLips | null {
  if (!(size >= 8 && frameW > 0 && frameH > 0)) return null;
  const n = size * size;
  if (probs.length < CLASSES * n) return null;
  const ramp = new Float32Array(n);
  const mouth = new Float32Array(n);
  let lipPx = 0;
  for (let i = 0; i < n; i++) {
    const lipP = (probs[UPPER_LIP * n + i] ?? 0) + (probs[LOWER_LIP * n + i] ?? 0);
    const m = probs[MOUTH * n + i] ?? 0;
    mouth[i] = m;
    const r = rampLip(lipP);
    ramp[i] = r;
    if (r >= ISO && m < ISO) lipPx += 1;
  }
  if (!lipFractionPlausible(lipPx, n)) return null;
  const lipField = largestComponent(ramp, size, ISO);
  const lipGrid = traceIso(lipField, size, ISO);
  if (!lipGrid) return null;
  const lip = lipGrid.map(([gx, gy]) => clampWire(gridToFrameNorm(gx, gy, crop, frameW, frameH, size)));
  if (lip.length < 32) return null;

  let sumL = 0, sumA = 0, sumB = 0, nL = 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if ((ramp[i] ?? 0) < ISO || (mouth[i] ?? 0) >= ISO) continue;
      if ((lipField[i] ?? 0) < ISO) continue;
      const [r, g, b] = rgbAt(x, y);
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      const lab = cieLab(r, g, b);
      sumL += lab.L;
      sumA += lab.a;
      sumB += lab.b;
      nL += 1;
    }
  }
  if (nL < 8) return null;
  const lipMean = clampLipMean({ L: sumL / nL, a: sumA / nL, b: sumB / nL });
  if (![lipMean.L, lipMean.a, lipMean.b].every(Number.isFinite)) return null;

  let lipInner: Array<[number, number]> | undefined;
  let mouthPx = 0;
  for (let i = 0; i < n; i++) if ((mouth[i] ?? 0) >= ISO) mouthPx += 1;
  if (mouthPx >= 8) {
    const mouthField = largestComponent(mouth, size, ISO);
    const innerGrid = traceIso(mouthField, size, ISO);
    if (innerGrid) {
      const inner = innerGrid.map(([gx, gy]) => clampWire(gridToFrameNorm(gx, gy, crop, frameW, frameH, size)));
      const innerArea = Math.abs(shoelace(inner));
      const outerArea = Math.abs(shoelace(lip));
      if (
        outerArea > 0
        && innerArea >= outerArea * LIP_INNER_MIN_FRAC
        && innerArea < outerArea * 0.55
        && mostlyInside(inner, lip)
        && !coversLipFlesh(innerGrid, ramp, mouth, size)
      ) {
        lipInner = inner;
      }
    }
  }
  const means = { lipMeanL: lipMean.L, lipMeanA: lipMean.a, lipMeanB: lipMean.b };
  return lipInner ? { lip, lipInner, ...means } : { lip, ...means };
}

/** Heuristic landmarks when parsing fails. Parsed lips replace the redness polygon. */
export function lipsOrHeuristic<T extends { lip: Poly }>(
  heuristic: T,
  parsed: ParsedLips | null,
): T & { lipInner?: Poly | undefined; lipMeanL?: number | undefined; lipMeanA?: number | undefined; lipMeanB?: number | undefined } {
  if (!parsed) return heuristic;
  const next = {
    ...heuristic,
    lip: parsed.lip,
    lipMeanL: parsed.lipMeanL,
    lipMeanA: parsed.lipMeanA,
    lipMeanB: parsed.lipMeanB,
  } as T & { lipInner?: Poly | undefined; lipMeanL?: number | undefined; lipMeanA?: number | undefined; lipMeanB?: number | undefined };
  delete next.lipInner;
  if (parsed.lipInner) next.lipInner = parsed.lipInner;
  return next;
}

/** One load per page. A failure stays null and capture keeps the heuristic lip. */
export function loadFaceParseSession(): Promise<OrtSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      try {
        const mod = await import("./faceModel");
        const ort = await mod.loadOrtRuntime();
        if (!ort) return null;
        const res = await fetch(MODEL_URL);
        if (!res.ok) return null;
        const buf = await res.arrayBuffer();
        if (buf.byteLength < 64) return null;
        return await mod.withOrtLock(() => ort.InferenceSession.create(new Uint8Array(buf), {
          executionProviders: ["wasm"],
        }));
      } catch {
        return null;
      }
    })();
  }
  return sessionPromise;
}

/**
 * Parse lips on the normalized frame. Null on a missing model, a bad
 * output, or an implausible lip area (the caller keeps the heuristic).
 */
export async function parseLips(
  canvas: HTMLCanvasElement,
  box: FaceBox,
): Promise<ParsedLips | null> {
  const session = await loadFaceParseSession();
  if (!session) return null;
  try {
    const mod = await import("./faceModel");
    const ort = await mod.loadOrtRuntime();
    if (!ort) return null;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const frameW = canvas.width, frameH = canvas.height;
    const crop = squareCropForBox(box, frameW, frameH);
    if (!crop) return null;
    const rgba = ctx.getImageData(0, 0, frameW, frameH).data;
    if (rgba.length < frameW * frameH * 4) return null;
    const input = cropToNchw(rgba, frameW, frameH, crop, PARSE_SIZE);
    const logits = await mod.withOrtLock(async () => {
      const name = session.inputNames.includes("input") ? "input" : (session.inputNames[0] ?? "input");
      const tensor = new ort.Tensor("float32", input, [1, 3, PARSE_SIZE, PARSE_SIZE]);
      let out: Record<string, OrtTensor> | undefined;
      try {
        out = await session.run({ [name]: tensor }) as Record<string, OrtTensor>;
        const key = session.outputNames.includes("logits") ? "logits" : (session.outputNames[0] ?? "logits");
        const vol = out[key];
        if (!vol || !logitsVolumeOk(vol.dims, vol.data.length)) return null;
        return copyLogits(vol.data, CLASSES * PARSE_SIZE * PARSE_SIZE);
      } finally {
        mod.releaseOrt(tensor);
        if (out) for (const t of Object.values(out)) mod.releaseOrt(t);
      }
    });
    if (!logits) return null;
    const probs = softmaxClassMajor(logits, CLASSES, PARSE_SIZE * PARSE_SIZE);
    return lipsFromClassProbs(probs, PARSE_SIZE, crop, frameW, frameH, (gx, gy) => {
      const px = crop.x + ((gx + 0.5) / PARSE_SIZE) * crop.size;
      const py = crop.y + ((gy + 0.5) / PARSE_SIZE) * crop.size;
      return sampleRgbEdge(rgba, frameW, frameH, px, py);
    });
  } catch {
    return null;
  }
}
