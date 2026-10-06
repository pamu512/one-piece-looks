/**
 * Client face utilities: the single geometry + the face-frame-first
 * landmark detector.
 *
 * Geometry contract (end to end): every capture is normalized to a 4:5
 * portrait frame (NORMAL_W x NORMAL_H) before sampling, locking, or
 * rendering. All fractional coordinates below refer to that 4:5 frame, so
 * the lock ring, the auto-suggested lock, and the server's mock patches all
 * share one coordinate space.
 *
 * Detection is face-frame-first (plan 2026-10-05): a stable faceBox is
 * decided BEFORE any lip/eye search, and the searches then happen only
 * inside WFLW-calibrated bands of that box (see lib/faceFrame.ts). The
 * faceBox priority ladder is: ONNX model (when onnxruntime-web and the
 * exported model are available, lazy, offline-safe) > skin-grid heuristic >
 * centered portrait prior. The old failure mode (skin box swallowing the
 * bottom hand band, lip patch landing on knuckles) is structurally closed:
 * the box is clamped out of the hand band unless the model is confident the
 * face fills the frame, and lips/eyes are never searched outside the box.
 *
 * detectFace() stays synchronous and dependency-free; the optional model
 * path is detectFaceWithModel(), an async wrapper with the same output
 * shape (FaceLandmarks), so App.tsx can await it and fall back cleanly.
 */

import {
  BROW_MID_Y, clampCenterInBand, decideFaceBox, EYE_BAND, MOUTH_BAND, eyeBand, mouthBand,
} from "./faceFrame";
import { detectFaceFrameModel } from "./faceModel";

/** WFLW eye band midpoint (test split): fallback eye height inside faceBox. */
const EYE_FALLBACK_Y = (EYE_BAND.y0 + EYE_BAND.y1) / 2;
/** WFLW mouth band midpoint (test split): fallback lip height inside faceBox. */
const MOUTH_FALLBACK_Y = (MOUTH_BAND.y0 + MOUTH_BAND.y1) / 2;

export const NORMAL_W = 1000;
export const NORMAL_H = 1250;

export interface FaceBox { x: number; y: number; w: number; h: number }
export type Poly = ReadonlyArray<readonly [number, number]>;

export interface FaceLandmarks {
  faceBox: FaceBox;
  lip: Poly;
  eyeL: Poly;
  eyeR: Poly;
  browL: Poly;
  browR: Poly;
  cheekL: Poly;
  cheekR: Poly;
}

/* ---------- geometry ---------- */

/** Center-crop any source to the shared 4:5 geometry. */
export function normalizeTo45(
  img: HTMLImageElement | HTMLCanvasElement | HTMLVideoElement,
): HTMLCanvasElement {
  const dims = (): [number, number] => {
    if (img instanceof HTMLVideoElement) return [img.videoWidth, img.videoHeight];
    if (img instanceof HTMLCanvasElement) return [img.width, img.height];
    return [img.naturalWidth || img.width, img.naturalHeight || img.height];
  };
  const [sw, sh] = dims();
  const c = document.createElement("canvas");
  c.width = NORMAL_W;
  c.height = NORMAL_H;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  const target = 4 / 5;
  const srcAR = sw / sh;
  let cw = sw, ch = sh;
  if (srcAR > target) { cw = sh * target; } else { ch = sw / target; }
  ctx.drawImage(img, (sw - cw) / 2, (sh - ch) / 2, cw, ch, 0, 0, NORMAL_W, NORMAL_H);
  return c;
}

/* ---------- detection ---------- */

function rgbToHsv(r: number, g: number, b: number): [number, number, number] {
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b);
  const d = mx - mn;
  let h = 0;
  if (d !== 0) {
    if (mx === r) h = ((g - b) / d) % 6;
    else if (mx === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return [h, mx === 0 ? 0 : d / mx, mx / 255];
}

/** Coarse skin-likelihood grid over the normalized frame. */
function skinGrid(ctx: CanvasRenderingContext2D, gw = 50, gh = 62): Float32Array {
  const data = ctx.getImageData(0, 0, NORMAL_W, NORMAL_H).data;
  const grid = new Float32Array(gw * gh);
  const cellW = NORMAL_W / gw, cellH = NORMAL_H / gh;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      let acc = 0, n = 0;
      const x0 = Math.floor(gx * cellW), y0 = Math.floor(gy * cellH);
      const x1 = Math.min(NORMAL_W, Math.floor((gx + 1) * cellW));
      const y1 = Math.min(NORMAL_H, Math.floor((gy + 1) * cellH));
      const stepX = Math.max(1, Math.floor((x1 - x0) / 4));
      const stepY = Math.max(1, Math.floor((y1 - y0) / 4));
      for (let y = y0; y < y1; y += stepY) {
        for (let x = x0; x < x1; x += stepX) {
          const i = (y * NORMAL_W + x) * 4;
          const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
          const [h, s, v] = rgbToHsv(r, g, b);
          let p = 0;
          if (h >= 0 && h <= 50 && s >= 0.15 && s <= 0.68 && v >= 0.35) {
            p = 1 - Math.abs(h - 25) / 40;
          }
          acc += p; n++;
        }
      }
      grid[gy * gw + gx] = n ? acc / n : 0;
    }
  }
  return grid;
}

interface Box { x0: number; y0: number; x1: number; y1: number }

function faceBounds(grid: Float32Array, gw: number, gh: number): Box {
  const thr = 0.28;
  let x0 = gw, y0 = gh, x1 = 0, y1 = 0;
  for (let gy = 0; gy < gh; gy++) {
    for (let gx = 0; gx < gw; gx++) {
      if (grid[gy * gw + gx]! > thr) {
        if (gx < x0) x0 = gx;
        if (gx > x1) x1 = gx;
        if (gy < y0) y0 = gy;
        if (gy > y1) y1 = gy;
      }
    }
  }
  if (x1 <= x0) return { x0: 0.25 * gw, y0: 0.15 * gh, x1: 0.75 * gw, y1: 0.92 * gh };
  // Trim to a robust core (drop stray rows/cols) via row/col mass.
  const colMass = new Float32Array(gw), rowMass = new Float32Array(gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const v = grid[gy * gw + gx]!;
      colMass[gx]! += v; rowMass[gy]! += v;
    }
  const trim = (mass: Float32Array, lo: number, hi: number): [number, number] => {
    const max = Math.max(...mass);
    const t = max * 0.35;
    let a = lo, b = hi;
    for (let i = lo; i <= hi; i++) if (mass[i]! > t) { a = i; break; }
    for (let i = hi; i >= lo; i--) if (mass[i]! > t) { b = i; break; }
    return [a, b];
  };
  [x0, x1] = trim(colMass, x0, x1);
  [y0, y1] = trim(rowMass, y0, y1);
  // A face in a 4:5 portrait must span a plausible range and be portrait
  // shaped; clamp extreme detections to the framing-guide band instead of
  // letting a background wash produce a degenerate box.
  const faceW = (x1 - x0) / gw, faceH = (y1 - y0) / gh;
  if (faceW > 0.9 || faceH < faceW * 1.05 || faceH > 1.0) {
    const w = Math.min(faceW, 0.62);
    const cx = (x0 + x1) / 2 / gw;
    const cy = Math.min(0.5, Math.max(0.42, (y0 + y1) / 2 / gh));
    return {
      x0: (cx - w / 2) * gw,
      x1: (cx + w / 2) * gw,
      y0: (cy - w * 1.3 / 2) * gh,
      y1: (cy + w * 1.3 / 2) * gh,
    };
  }
  return { x0, y0, x1, y1 };
}

/** Mean patch color in normalized coordinates. */
export function patchMean(ctx: CanvasRenderingContext2D, cx: number, cy: number, r = 12): [number, number, number] {
  const x = Math.round(cx * NORMAL_W), y = Math.round(cy * NORMAL_H);
  const d = ctx.getImageData(Math.max(0, x - r), Math.max(0, y - r), r * 2 + 1, r * 2 + 1).data;
  let rs = 0, gs = 0, bs = 0, n = 0;
  for (let i = 0; i < d.length; i += 4) { rs += d[i]!; gs += d[i + 1]!; bs += d[i + 2]!; n++; }
  return [rs / n, gs / n, bs / n];
}

function polyFromBox(cx: number, cy: number, rx: number, ry: number, n = 8): Poly {
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    pts.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return pts;
}

/**
 * Detect face landmarks on the normalized 4:5 canvas, face-frame-first.
 *
 * The faceBox is decided from the skin grid (model candidates are injected
 * by detectFaceWithModel), clamped out of the bottom hand band, and ONLY
 * THEN are lips searched inside the WFLW mouth band of that box and eyes
 * inside the WFLW eye band. Synchronous, dependency-free; good enough to
 * align mock patches and to pre-stamp a lock ring, and every suggestion is
 * still one tap away from correction.
 */
export function detectFace(canvas: HTMLCanvasElement, modelBox?: { box: FaceBox; conf: number } | null): FaceLandmarks | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  const gw = 50, gh = 62;
  const grid = skinGrid(ctx, gw, gh);
  const b = faceBounds(grid, gw, gh);
  const skinCandidate: FaceBox | null = (b.x1 > b.x0)
    ? { x: b.x0 / gw, y: b.y0 / gh, w: (b.x1 - b.x0) / gw, h: (b.y1 - b.y0) / gh }
    : null;

  const decision = decideFaceBox(modelBox ?? null, skinCandidate);
  const faceBox = decision.faceBox;
  const fx0 = faceBox.x, fy0 = faceBox.y, fw = faceBox.w, fh = faceBox.h;
  const cx = fx0 + fw / 2;

  // --- eyes: independent darkest patch in each half of the iris band ---
  // Ceil the start so the 0.01 grid cannot step above the band into the brow.
  const eye = eyeBand(faceBox);
  let eyeL: [number, number] | null = null, eyeR: [number, number] | null = null;
  {
    const r = 8;
    let bestL = Infinity, bestR = Infinity;
    const gy0 = Math.ceil(eye.y0 * 100 - 1e-9);
    const gy1 = Math.floor(eye.y1 * 100 + 1e-9);
    const gx0 = Math.ceil(eye.x0 * 100 - 1e-9);
    const gx1 = Math.floor(eye.x1 * 100 + 1e-9);
    for (let gy = gy0; gy <= gy1; gy += 2) {
      for (let gx = gx0; gx <= gx1; gx += 2) {
        const [rr, gg, bb] = patchMean(ctx, gx / 100, gy / 100, r / 2);
        const lum = 0.299 * rr + 0.587 * gg + 0.114 * bb;
        if (gx / 100 < cx) {
          if (lum < bestL) { bestL = lum; eyeL = [gx / 100, gy / 100]; }
        } else {
          if (lum < bestR) { bestR = lum; eyeR = [gx / 100, gy / 100]; }
        }
      }
    }
  }
  // Fallback centers inside the same WFLW eye band (never below it).
  const eyeMidY = fy0 + fh * EYE_FALLBACK_Y;
  if (!eyeL) eyeL = [cx - fw * 0.19, eyeMidY];
  if (!eyeR) eyeR = [cx + fw * 0.19, eyeMidY];
  const eyeR2 = Math.max(fw * 0.055, 0.035);
  const eyeRy = eyeR2 * 0.62;
  eyeL = [
    clampCenterInBand(eyeL[0], eye.x0, eye.x1, eyeR2),
    clampCenterInBand(eyeL[1], eye.y0, eye.y1, eyeRy),
  ];
  eyeR = [
    clampCenterInBand(eyeR[0], eye.x0, eye.x1, eyeR2),
    clampCenterInBand(eyeR[1], eye.y0, eye.y1, eyeRy),
  ];

  // --- lips: redness peak inside the WFLW mouth band of faceBox ---
  const mouth = mouthBand(faceBox);
  let lip: [number, number] = [
    fx0 + fw * 0.5,
    fy0 + fh * MOUTH_FALLBACK_Y,
  ];
  {
    let bestScore = -Infinity;
    const y0 = Math.max(1, Math.floor(mouth.y0 * 100)), y1 = Math.min(98, Math.floor(mouth.y1 * 100));
    for (let gy = y0; gy <= y1; gy += 2) {
      for (let gx = Math.floor(mouth.x0 * 100); gx <= Math.floor(mouth.x1 * 100); gx += 2) {
        const [r, g, bb] = patchMean(ctx, gx / 100, gy / 100, 3);
        const score = (r - Math.max(g, bb)) - Math.abs(g - bb) * 0.25;
        if (score > bestScore) { bestScore = score; lip = [gx / 100, gy / 100]; }
      }
    }
  }

  const lipR = { rx: fw * 0.11, ry: Math.max(fh * 0.035, 0.02) };
  const lipCx = clampCenterInBand(lip[0], mouth.x0, mouth.x1, lipR.rx);
  const lipCy = clampCenterInBand(lip[1], mouth.y0, mouth.y1, lipR.ry);
  const browY = fy0 + fh * BROW_MID_Y;

  return {
    faceBox,
    lip: polyFromBox(lipCx, lipCy, lipR.rx, lipR.ry, 10),
    eyeL: polyFromBox(eyeL[0], eyeL[1], eyeR2, eyeR2 * 0.62, 8),
    eyeR: polyFromBox(eyeR[0], eyeR[1], eyeR2, eyeR2 * 0.62, 8),
    browL: polyFromBox(eyeL[0], (eyeL[1] + browY) / 2, eyeR2 * 1.15, eyeR2 * 0.32, 8),
    browR: polyFromBox(eyeR[0], (eyeR[1] + browY) / 2, eyeR2 * 1.15, eyeR2 * 0.32, 8),
    cheekL: polyFromBox(eyeL[0] - fw * 0.13, eyeL[1] + fh * 0.18, fw * 0.085, fh * 0.06, 10),
    cheekR: polyFromBox(eyeR[0] + fw * 0.13, eyeR[1] + fh * 0.18, fw * 0.085, fh * 0.06, 10),
  };
}

/**
 * Async model path: ONNX faceBox when available, heuristic otherwise.
 * Same output shape as detectFace; never rejects (model errors fall back).
 */
export async function detectFaceWithModel(canvas: HTMLCanvasElement): Promise<FaceLandmarks | null> {
  const model = await detectFaceFrameModel(canvas).catch(() => null);
  return detectFace(canvas, model);
}

/**
 * Suggest the lock from the detected face: sample the strongest-saturation
 * cluster in the lower face (lips first), then cheeks, then eyes; return the
 * category, hex, and point in 4:5 fractional coordinates.
 */
export function suggestLock(
  canvas: HTMLCanvasElement,
  lm: FaceLandmarks,
): { category: "lip" | "cheek" | "eye" | "brow" | "liner"; hex: string; point: { xPct: number; yPct: number } } | null {
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;

  const centroid = (p: Poly): [number, number] => {
    let sx = 0, sy = 0;
    for (const [x, y] of p) { sx += x; sy += y; }
    return [sx / p.length, sy / p.length];
  };

  interface Cand { cat: "lip" | "cheek" | "eye"; pt: [number, number]; score: number; rgb: [number, number, number] }
  const cands: Cand[] = [];
  const zones: { cat: Cand["cat"]; poly: Poly }[] = [
    { cat: "lip", poly: lm.lip },
    { cat: "cheek", poly: lm.cheekL },
    { cat: "cheek", poly: lm.cheekR },
    { cat: "eye", poly: lm.eyeL },
    { cat: "eye", poly: lm.eyeR },
  ];
  for (const z of zones) {
    const [cx, cy] = centroid(z.poly);
    const rgb = patchMean(ctx, cx, cy, 6);
    const [, sat, val] = rgbToHsv(...rgb);
    // Color presence: saturation that survives a brightness floor, so
    // near-black pixels (sat ~1, v ~0) don't masquerade as vivid color.
    const score = sat * Math.min(1, val / 0.35);
    cands.push({ cat: z.cat, pt: [cx, cy], score, rgb });
  }
  cands.sort((a, b) => b.score - a.score);
  const top = cands[0];
  if (!top || top.score < 0.18) return null;

  const hex = `#${[top.rgb[0], top.rgb[1], top.rgb[2]]
    .map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, "0"))
    .join("")}`;
  return { category: top.cat, hex, point: { xPct: top.pt[0] * 100, yPct: top.pt[1] * 100 } };
}
