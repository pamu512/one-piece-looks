/**
 * Face-frame-first geometry: the WFLW-calibrated bands and the faceBox
 * decision ladder, as pure functions (unit-testable under node).
 *
 * Contract (see face.ts): all fractions refer to the shared 4:5 normalized
 * frame (1000x1250). The frame has a known failure mode: a hand holding a
 * product near the bottom edge reads as skin, so the legacy skin-grid box
 * swallows it. This module makes the guard rails explicit:
 *
 *  - detectFace() picks faceBox by priority: model (ONNX) > skin-grid
 *    heuristic > centered portrait prior.
 *  - Every candidate passes clampFaceBox(): finite, inside the frame,
 *    portrait-shaped, and NEVER extending into the bottom hand band unless
 *    the model is confident the face genuinely fills the frame.
 *  - Lips and eyes are then searched ONLY inside the WFLW bands of that box
 *    (mouthBand / eyeBand below), so nothing below faceBox can win.
 *
 * Band numbers come from apps/client/src/lib/face-bands.json (WFLW, 7500
 * train / 2500 test faces; regenerate with scripts/train/wflw-bands.py).
 * Mouth uses test-split p5/p95, widened slightly. The eye band starts
 * below the brow midline so a dark eyebrow cannot win the iris search.
 */

import type { FaceBox } from "./face";

/*
 * Band literals below are DERIVED from apps/client/src/lib/face-bands.json
 * (WFLW test split, 2500 faces). faceFrame.test.ts asserts the literals
 * still equal the JSON, so regenerating the JSON without updating these
 * constants fails the test instead of shipping drift.
 */
const TEST_MOUTH_P5 = 0.6261, TEST_MOUTH_P95 = 0.849;
const TEST_EYE_MEAN = 0.3788;
const TEST_BROW_MEAN = 0.2885;

/** Below this y (fraction of the full frame) is the known hand band. */
export const HAND_BAND_Y = 0.9;

/** Mouth band inside any faceBox: WFLW mouth_y p5..p95, margin-widened. */
export const MOUTH_BAND = {
  y0: Math.floor((TEST_MOUTH_P5 - 0.04) * 100) / 100, // 0.58
  y1: Math.ceil((TEST_MOUTH_P95 + 0.03) * 100) / 100, // 0.88
  x0: 0.18,
  x1: 0.82,
} as const;

/**
 * Eye band inside any faceBox. y0 sits below the WFLW brow midline
 * (mean 0.2885 + 0.05, ceiled) so the search cannot lock onto the eyebrow.
 * y1 stays just under the iris mean + 0.10, which still covers the pupil
 * (test eye_y mean 0.3788) without reaching the nose.
 * x is split per eye at the face midline in detectFace (not one shared peak).
 */
export const EYE_BAND = {
  y0: Math.ceil((TEST_BROW_MEAN + 0.05) * 100) / 100, // 0.34
  y1: Math.ceil((TEST_EYE_MEAN + 0.10) * 100) / 100, // 0.48
  x0: 0.08,
  x1: 0.92,
} as const;

/** Brow band (for the brow polys derived above the eyes). */
export const BROW_MID_Y = TEST_BROW_MEAN;

export type FaceBoxSource = "model" | "skin" | "prior";

export interface FaceBoxDecision {
  faceBox: FaceBox;
  source: FaceBoxSource;
  /** True when the box survived clamping as-is (model or plausible skin). */
  confident: boolean;
}

/** Centered portrait prior: where a face sits when detection is unsure. */
export function portraitPriorFaceBox(): FaceBox {
  const w = 0.62;
  const h = 0.72;
  const cx = 0.5;
  const cy = 0.5;
  return { x: cx - w / 2, y: cy - h / 2, w, h }; // y: 0.14..0.86, clear of the hand band
}

function isFiniteBox(b: FaceBox): boolean {
  return [b.x, b.y, b.w, b.h].every(Number.isFinite) && b.w > 0 && b.h > 0;
}

/**
 * Sanitize any candidate faceBox. Returns null when the candidate is
 * unusable (caller falls back down the priority ladder); otherwise a box
 * that is finite, inside the frame, portrait-shaped, and kept out of the
 * bottom hand band unless `faceFillsFrame` (model-only, high confidence).
 */
export function clampFaceBox(raw: FaceBox, opts?: { faceFillsFrame?: boolean }): FaceBox | null {
  if (!isFiniteBox(raw)) return null;
  // Pull inside the frame first.
  const x = Math.max(0, Math.min(1, raw.x));
  const y = Math.max(0, Math.min(1, raw.y));
  const w = Math.min(1 - x, raw.w);
  const h = Math.min(1 - y, raw.h);
  if (w < 0.05 || h < 0.05) return null; // nothing usable left

  // A face in a 4:5 portrait is taller than wide, never extremely so.
  const ar = h / w;
  if (ar < 0.9 || ar > 2.4) return null;

  let box: FaceBox = { x, y, w, h };

  // Hand-band guard: the bottom strip is where hands live. Only a model box
  // that confidently says the face fills the frame may reach into it.
  const fills = opts?.faceFillsFrame === true;
  const bottom = box.y + box.h;
  if (bottom > HAND_BAND_Y) {
    if (fills && box.h >= 0.6) {
      // Genuine full-frame face (chin cropped by the frame edge): allow it.
      box = { ...box, h: Math.min(1 - box.y, box.h) };
    } else {
      box = { ...box, h: HAND_BAND_Y - box.y };
      if (box.h < 0.15) return null; // candidate lived entirely in the hand band
    }
  }
  return box;
}

/**
 * Pull a patch center into [lo, hi] so the patch of radius r stays inside.
 * A band thinner than the patch collapses to the midpoint.
 */
export function clampCenterInBand(v: number, lo: number, hi: number, r: number): number {
  const a = lo + r;
  const b = hi - r;
  if (!(b > a)) return (lo + hi) / 2;
  return Math.min(b, Math.max(a, v));
}

/** Absolute-frame rect (fractions) of the mouth search band inside faceBox. */
export function mouthBand(fb: FaceBox): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: fb.x + fb.w * MOUTH_BAND.x0,
    x1: fb.x + fb.w * MOUTH_BAND.x1,
    y0: fb.y + fb.h * MOUTH_BAND.y0,
    y1: fb.y + fb.h * MOUTH_BAND.y1,
  };
}

/** Absolute-frame rect (fractions) of the eye search band inside faceBox. */
export function eyeBand(fb: FaceBox): { x0: number; y0: number; x1: number; y1: number } {
  return {
    x0: fb.x + fb.w * EYE_BAND.x0,
    x1: fb.x + fb.w * EYE_BAND.x1,
    y0: fb.y + fb.h * EYE_BAND.y0,
    y1: fb.y + fb.h * EYE_BAND.y1,
  };
}

/**
 * Lip polygon for the mouth band: outline of the redness mass, no outward skirt.
 *
 * A 2×2 mean keeps one hot pixel from collapsing the fill. Cells at >= 55%
 * of the in-window peak are the loose mass. A flat dim plateau that fills
 * the search window is peeled back to the hotter lip. A gradient that merely
 * fills the window stays: that is the vermillion, not a mouth-rectangle stamp.
 * Connected cells down to 55% of the peak (the alignment ground truth)
 * join the core. A hotter spot off to one side recenters that window on
 * the mass so the far vermillion is inside it. Cooler commissures, down
 * to 40% and only outward along lip rows, stay. A flat surround peeled
 * as a mouth stamp is not grown back. Vertical growth that pulls the
 * mass off the core is shed. Lateral commissures are not.
 * A cupid notch between shoulders stays empty. A second lip across a gap of
 * at most two cells is bridged. The outline is the cell boundary, nudged out
 * by a fraction of a cell so lip flesh tests inside and the next cell does
 * not. A convex hull is only the fallback when that boundary cannot be traced.
 */
export function selectLipPolygon(
  width: number,
  height: number,
  faceBox: FaceBox,
  scoreAt: (x: number, y: number) => number,
): Array<[number, number]> | null {
  if (!(width >= 2 && height >= 2) || !(faceBox.w > 0 && faceBox.h > 0)) return null;
  const band = mouthBand(faceBox);
  const sx = width >= 8 ? 2 : 1;
  const sy = height >= 8 ? 2 : 1;
  const hw = Math.ceil(width / sx);
  const hh = Math.ceil(height / sy);
  const x0 = clampPx(Math.floor(band.x0 * width), width);
  const x1 = clampPx(Math.ceil(band.x1 * width), width);
  const y0 = clampPx(Math.floor(band.y0 * height), height);
  const y1 = clampPx(Math.ceil(band.y1 * height), height);
  const acc = new Float64Array(hw * hh);
  const cnt = new Uint16Array(hw * hh);
  for (let y = y0; y <= y1; y++) {
    const hy = Math.min(hh - 1, (y / sy) | 0);
    for (let x = x0; x <= x1; x++) {
      const s = scoreAt(x, y);
      if (!Number.isFinite(s)) continue;
      const i = hy * hw + Math.min(hw - 1, (x / sx) | 0);
      acc[i] = (acc[i] ?? 0) + s;
      cnt[i] = (cnt[i] ?? 0) + 1;
    }
  }
  const grid = new Float32Array(hw * hh);
  grid.fill(Number.NEGATIVE_INFINITY);
  for (let i = 0; i < grid.length; i++) {
    if (cnt[i]! > 0) grid[i] = acc[i]! / cnt[i]!;
  }

  const rad = 1;
  const ker = (rad * 2 + 1) * (rad * 2 + 1);
  let peakB = -Infinity;
  let phx = (Math.min(hw - 1, (x0 / sx) | 0) + Math.min(hw - 1, (x1 / sx) | 0)) >> 1;
  let phy = (Math.min(hh - 1, (y0 / sy) | 0) + Math.min(hh - 1, (y1 / sy) | 0)) >> 1;
  const hy0 = Math.min(hh - 1, (y0 / sy) | 0);
  const hy1 = Math.min(hh - 1, (y1 / sy) | 0);
  const hx0 = Math.min(hw - 1, (x0 / sx) | 0);
  const hx1 = Math.min(hw - 1, (x1 / sx) | 0);
  for (let hy = hy0; hy <= hy1; hy++) {
    for (let hx = hx0; hx <= hx1; hx++) {
      let sum = 0;
      for (let dy = -rad; dy <= rad; dy++) {
        const yy = hy + dy;
        if (yy < 0 || yy >= hh) continue;
        for (let dx = -rad; dx <= rad; dx++) {
          const xx = hx + dx;
          if (xx < 0 || xx >= hw) continue;
          const v = grid[yy * hw + xx]!;
          if (v > -1e20) sum += v;
        }
      }
      const s = sum / ker;
      if (s > peakB) { peakB = s; phx = hx; phy = hy; }
    }
  }
  if (!(peakB > 0)) return null;

  const wx = Math.max(2, Math.round(0.17 * faceBox.w * hw));
  const wy = Math.max(2, Math.round(0.055 * faceBox.h * hh));

  const bounds = (cx: number, cy: number) => ({
    xa: Math.max(0, Math.round(cx) - wx),
    xb: Math.min(hw - 1, Math.round(cx) + wx),
    ya: Math.max(0, Math.round(cy) - wy),
    yb: Math.min(hh - 1, Math.round(cy) + wy),
  });

  const windowMax = (cx: number, cy: number): number => {
    const { xa, xb, ya, yb } = bounds(cx, cy);
    let max = -Infinity;
    for (let hy = ya; hy <= yb; hy++) {
      for (let hx = xa; hx <= xb; hx++) {
        const v = grid[hy * hw + hx]!;
        if (v > max) max = v;
      }
    }
    return max;
  };

  const collect = (cx: number, cy: number, thr: number) => {
    const { xa, xb, ya, yb } = bounds(cx, cy);
    const pts: [number, number][] = [];
    const cells: [number, number][] = [];
    let mx = 0, my = 0, n = 0;
    for (let hy = ya; hy <= yb; hy++) {
      for (let hx = xa; hx <= xb; hx++) {
        const v = grid[hy * hw + hx]!;
        if (!(v >= thr)) continue;
        const xA = hx * sx;
        const xB = Math.min(width, (hx + 1) * sx);
        const yA = hy * sy;
        const yB = Math.min(height, (hy + 1) * sy);
        cells.push([hx, hy]);
        pts.push([xA, yA], [xB, yA], [xB, yB], [xA, yB]);
        mx += (xA + xB) / 2;
        my += (yA + yB) / 2;
        n += 1;
      }
    }
    return { pts, cells, cx: n ? mx / n : (Math.round(cx) + 0.5) * sx, cy: n ? my / n : (Math.round(cy) + 0.5) * sy, n };
  };

  const placed = (cx: number, cy: number) => {
    const max = windowMax(cx, cy);
    const empty = { pts: [] as [number, number][], cells: [] as [number, number][], cx: (Math.round(cx) + 0.5) * sx, cy: (Math.round(cy) + 0.5) * sy, n: 0 };
    if (!(max > 0)) return empty;
    const box = bounds(cx, cy);
    const loose = collect(cx, cy, max * 0.55);
    let core = loose;
    if (loose.n >= 12 && lipMassIsStamp(loose.cells, box)) {
      for (let step = 58; step <= 86; step += 4) {
        const next = collect(cx, cy, max * step / 100);
        if (next.n < 12) break;
        if (lipMassIsStamp(next.cells, box)) continue;
        // A gradient lip that fills the window is vermillion. Only a flat
        // plateau (the dim mouth rectangle) is peeled off.
        if (!droppedAreFlat(loose.cells, next.cells, grid, hw)) break;
        core = next;
        for (let back = step - 2; back >= 56; back -= 2) {
          const wider = collect(cx, cy, max * back / 100);
          if (wider.n < 12 || lipMassIsStamp(wider.cells, box)) break;
          if (!droppedAreFlat(loose.cells, wider.cells, grid, hw)) break;
          core = wider;
        }
        break;
      }
    }
    // Cells the stamp peel removed stay out. Growing them back is the dim mouth.
    const peeled = core.cells !== loose.cells;
    if (peeled) buryPeeled(grid, hw, loose.cells, core.cells);
    // A hot spot sits off the lip center. The union of that window with the
    // peak window kept blonde paint low and right of the vermillion.
    let gx = 0, gy = 0;
    for (const [x, y] of core.cells) { gx += x; gy += y; }
    const ccx = core.cells.length ? gx / core.cells.length : cx;
    const ccy = core.cells.length ? gy / core.cells.length : cy;
    const recent = bounds(ccx, ccy);
    let span = {
      xa: Math.min(box.xa, recent.xa),
      xb: Math.max(box.xb, recent.xb),
      ya: Math.min(box.ya, recent.ya),
      yb: Math.max(box.yb, recent.yb),
    };
    if (!peeled && core.n >= 12 && Math.hypot(ccx - cx, ccy - cy) >= 1) {
      const shifted = collect(ccx, ccy, max * 0.55);
      if (shifted.n >= 12 && shifted.n >= core.n * 0.5 && !lipMassIsStamp(shifted.cells, recent)) {
        core = shifted;
        span = recent;
      }
    }
    const grown = shedPulledSkirt(core.cells, growCommissures(grid, hw, hh, span, core.cells, max * 0.55));
    const rows = growRowCommissures(grid, hw, hh, span, grown, max * 0.4);
    const cells = bridgeCellGaps(attachSecondLip(grid, hw, span, rows, max * 0.55), hw, hh);
    if (cells.length === 0) return empty;
    const pts: [number, number][] = [];
    let mx = 0, my = 0;
    for (const [hx, hy] of cells) {
      const xA = hx * sx;
      const xB = Math.min(width, (hx + 1) * sx);
      const yA = hy * sy;
      const yB = Math.min(height, (hy + 1) * sy);
      pts.push([xA, yA], [xB, yA], [xB, yB], [xA, yB]);
      mx += (xA + xB) / 2;
      my += (yA + yB) / 2;
    }
    const n = cells.length;
    return { pts, cells, cx: mx / n, cy: my / n, n };
  };

  const mask = placed(phx, phy);
  const outline = lipMassOutline(mask.cells, sx, sy);
  if (outline && outline.length >= 3) {
    return outline.map(([x, y]) => [x / width, y / height]);
  }
  const pts: [number, number][] = mask.pts.length > 0 ? mask.pts : [[phx * sx + sx / 2, phy * sy + sy / 2]];
  const hull = convexHull(pts);
  // v3b: the corner lift that lipMassOutline applies to its rings must also
  // cover this fallback hull - a 4-7 corner hull is the same blocky outline
  // and callers require >= 8 outline points. Midpoints stay on the hull edges,
  // so the shape (and area) does not grow: no skirt, no halo.
  const shape = hull.length >= 3 ? (hull.length < 8 ? liftCornerCount(hull) : hull) : boxEllipse(pts);
  return shape.map(([x, y]) => [x / width, y / height]);
}

function clampPx(v: number, limit: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(limit - 1, v));
}

function boxEllipse(pts: ReadonlyArray<readonly [number, number]>): [number, number][] {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of pts) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const cx = (minX + maxX) / 2, cy = (minY + maxY) / 2;
  const rx = Math.max(3, (maxX - minX) / 2 + 1.5);
  const ry = Math.max(2, (maxY - minY) / 2 + 1.5);
  const out: [number, number][] = [];
  for (let i = 0; i < 12; i++) {
    const t = (i / 12) * Math.PI * 2;
    out.push([cx + Math.cos(t) * rx, cy + Math.sin(t) * ry]);
  }
  return out;
}

/**
 * Outline of the lip-flesh cells. No outward grow.
 * ponytail: a second mass more than 2 cells away stays out (open mouth).
 * Upgrade path: emit that mass as its own subpath.
 */

/**
 * True when the mass is a filled rectangle of the mouth search window.
 * 12/15 and 13/15 count. Fill stays at 0.82 so a lip ellipse (~0.78) does not.
 */
function lipMassIsStamp(
  cells: ReadonlyArray<readonly [number, number]>,
  box: { xa: number; xb: number; ya: number; yb: number },
): boolean {
  if (cells.length < 12) return false;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bw < 2 || bh < 2) return false;
  const ww = box.xb - box.xa + 1;
  const wh = box.yb - box.ya + 1;
  if (!(ww > 0 && wh > 0)) return false;
  const fill = cells.length / (bw * bh);
  return bw * 5 >= ww * 4 && bh * 5 >= wh * 4 && fill >= 0.82;
}

/**
 * True when the cells in `loose` but not `tight` are one flat score.
 * The dim mouth rectangle is flat. A vermillion gradient is not.
 */
function droppedAreFlat(
  loose: ReadonlyArray<readonly [number, number]>,
  tight: ReadonlyArray<readonly [number, number]>,
  grid: Float32Array,
  hw: number,
): boolean {
  const keep = new Uint8Array(grid.length);
  for (const [x, y] of tight) {
    if (x < 0 || y < 0 || x >= hw) continue;
    const i = y * hw + x;
    if (i >= 0 && i < keep.length) keep[i] = 1;
  }
  const vals: number[] = [];
  for (const [x, y] of loose) {
    if (x < 0 || y < 0 || x >= hw) continue;
    const i = y * hw + x;
    if (i < 0 || i >= grid.length || keep[i]) continue;
    const v = grid[i]!;
    if (Number.isFinite(v)) vals.push(v);
  }
  if (vals.length < 12) return false;
  vals.sort((a, b) => a - b);
  const med = vals[vals.length >> 1]!;
  let close = 0;
  for (const v of vals) if (Math.abs(v - med) <= 3) close++;
  return close / vals.length >= 0.72;
}

/** Stamp-peeled cells must not regrow. `loose` is the pre-peel mass. */
function buryPeeled(
  grid: Float32Array,
  hw: number,
  loose: ReadonlyArray<readonly [number, number]>,
  core: ReadonlyArray<readonly [number, number]>,
): void {
  const gh = hw > 0 ? (grid.length / hw) | 0 : 0;
  if (gh < 1) return;
  const keep = new Uint8Array(hw * gh);
  for (const [x, y] of core) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    keep[y * hw + x] = 1;
  }
  for (const [x, y] of loose) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    const i = y * hw + x;
    if (!keep[i]) grid[i] = Number.NEGATIVE_INFINITY;
  }
}

/**
 * Cooler lip flesh at or above `floor`, 4-connected to the core.
 * A cell already bracketed on its row is a cupid notch and stays empty.
 * Growth that turns the mass into a filled window stamp is dropped.
 * ponytail: one flood inside the recentered search window. Vermillion
 * outside that window stays clipped. Upgrade path: a second window on the
 * other lip when the mouth is open.
 */
function growCommissures(
  grid: Float32Array,
  hw: number,
  gh: number,
  box: { xa: number; xb: number; ya: number; yb: number },
  core: ReadonlyArray<readonly [number, number]>,
  floor: number,
): [number, number][] {
  if (core.length === 0 || hw < 1 || gh < 1) return [];
  const seen = new Uint8Array(hw * gh);
  const coreCells: [number, number][] = [];
  const rowLo = new Int32Array(gh).fill(-1);
  const rowHi = new Int32Array(gh).fill(-1);
  for (const [x, y] of core) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    const i = y * hw + x;
    if (seen[i]) continue;
    seen[i] = 1;
    coreCells.push([x, y]);
    if (rowLo[y]! < 0 || x < rowLo[y]!) rowLo[y] = x;
    if (x > rowHi[y]!) rowHi[y] = x;
  }
  if (coreCells.length === 0) return [];
  const xLo = Math.max(0, box.xa);
  const xHi = Math.min(hw - 1, box.xb);
  const yLo = Math.max(0, box.ya);
  const yHi = Math.min(gh - 1, box.yb);
  const notch = (x: number, y: number) => rowLo[y]! >= 0 && x > rowLo[y]! && x < rowHi[y]!;
  const out = coreCells.slice();
  const stack = coreCells.slice();
  while (stack.length) {
    const [x, y] = stack.pop()!;
    for (let k = 0; k < 4; k++) {
      const nx = x + N4X[k]!;
      const ny = y + N4Y[k]!;
      if (nx < xLo || ny < yLo || nx > xHi || ny > yHi) continue;
      const i = ny * hw + nx;
      if (seen[i] || notch(nx, ny) || !(grid[i]! >= floor)) continue;
      seen[i] = 1;
      out.push([nx, ny]);
      stack.push([nx, ny]);
      if (rowLo[ny]! < 0 || nx < rowLo[ny]!) rowLo[ny] = nx;
      if (nx > rowHi[ny]!) rowHi[ny] = nx;
    }
  }
  if (out.length > coreCells.length && lipMassIsStamp(out, box)) return coreCells;
  return out;
}

/**
 * Cooler commissures outward along rows the core already occupies.
 * Six cells covers the unit ellipse's outer ring. Farther than that on
 * a lip row is cheek. A walk that fills the window is dropped.
 * ponytail: no vertical grow here. Upgrade path: follow a tapering row
 * until the score falls off, instead of a fixed 6-cell cap.
 */
function growRowCommissures(
  grid: Float32Array,
  hw: number,
  gh: number,
  box: { xa: number; xb: number; ya: number; yb: number },
  cells: readonly [number, number][],
  floor: number,
): [number, number][] {
  if (cells.length === 0 || hw < 1 || gh < 1) return cells.map(([x, y]) => [x, y]);
  const out = cells.map(([x, y]) => [x, y] as [number, number]);
  const seen = new Uint8Array(hw * gh);
  const rowLo = new Int32Array(gh).fill(hw);
  const rowHi = new Int32Array(gh).fill(-1);
  for (const [x, y] of out) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    seen[y * hw + x] = 1;
    if (x < rowLo[y]!) rowLo[y] = x;
    if (x > rowHi[y]!) rowHi[y] = x;
  }
  const xLo = Math.max(0, box.xa);
  const xHi = Math.min(hw - 1, box.xb);
  const cap = 6;
  for (let y = 0; y < gh; y++) {
    if (rowHi[y]! < 0) continue;
    for (const dir of [-1, 1] as const) {
      let x = (dir < 0 ? rowLo[y]! : rowHi[y]!) + dir;
      for (let n = 0; n < cap && x >= xLo && x <= xHi; n++, x += dir) {
        const i = y * hw + x;
        if (seen[i] || !(grid[i]! >= floor)) break;
        seen[i] = 1;
        out.push([x, y]);
      }
    }
  }
  if (out.length > cells.length && lipMassIsStamp(out, box)) return cells.map(([x, y]) => [x, y]);
  return out;
}

/**
 * Vertical growth on the heavy side of the core is skin under the lip,
 * and it walks the mass centroid off the vermillion. Lateral flesh on
 * the lip rows stays, including a commissure farther than four cells.
 * Symmetric upper and lower flesh (pull near 0) stays.
 */
function shedPulledSkirt(
  core: ReadonlyArray<readonly [number, number]>,
  grown: ReadonlyArray<readonly [number, number]>,
): [number, number][] {
  if (core.length === 0 || grown.length <= core.length) return grown.map(([x, y]) => [x, y]);
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  let sx = 0, sy = 0;
  const keep = new Set<string>();
  for (const [x, y] of core) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
    sx += x;
    sy += y;
    keep.add(`${x},${y}`);
  }
  const cx = sx / core.length;
  const cy = sy / core.length;
  let gx = 0, gy = 0;
  for (const [x, y] of grown) { gx += x; gy += y; }
  const pullX = gx / grown.length - cx;
  const pullY = gy / grown.length - cy;
  if (Math.hypot(pullX, pullY) < 0.5) return grown.map(([x, y]) => [x, y]);
  const out: [number, number][] = [];
  for (const [x, y] of grown) {
    if (keep.has(`${x},${y}`)) { out.push([x, y]); continue; }
    // Lateral flesh is a commissure. Below or above the lip rows, on the
    // heavy side, is the skirt that shifts the centroid.
    const side = (x < minX || x > maxX) && y >= minY - 1 && y <= maxY + 1;
    if (side) { out.push([x, y]); continue; }
    if (pullY > 0.5 && y > maxY) continue;
    if (pullY < -0.5 && y < minY) continue;
    if (pullX > 0.5 && x > maxX) continue;
    if (pullX < -0.5 && x < minX) continue;
    out.push([x, y]);
  }
  return out.length >= core.length ? out : grown.map(([x, y]) => [x, y]);
}

function lineCells(ax: number, ay: number, bx: number, by: number): [number, number][] {
  const out: [number, number][] = [];
  let x = ax, y = ay;
  const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
  const sxn = ax < bx ? 1 : -1, syn = ay < by ? 1 : -1;
  let err = dx - dy;
  for (let n = 0; n <= dx + dy; n++) {
    out.push([x, y]);
    if (x === bx && y === by) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sxn; }
    if (e2 < dx) { err += dx; y += syn; }
  }
  return out;
}

/**
 * A second lip left below the core cutoff, within a 2-cell gap.
 * A component tucked between shoulders is a notch, not a lip, and stays out.
 * A union that fills the search window is the dim surround and stays out.
 * ponytail: one extra mass, the largest. Upgrade path: keep every lip-sized
 * component as its own subpath (open mouth).
 */
function attachSecondLip(
  grid: Float32Array,
  hw: number,
  box: { xa: number; xb: number; ya: number; yb: number },
  cells: readonly [number, number][],
  floor: number,
): [number, number][] {
  const gh = hw > 0 ? (grid.length / hw) | 0 : 0;
  if (cells.length === 0 || gh < 1) return cells.slice();
  const seen = new Uint8Array(hw * gh);
  const row = new Map<number, { lo: number; hi: number }>();
  let cminX = Infinity, cmaxX = -Infinity;
  for (const [x, y] of cells) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    seen[y * hw + x] = 1;
    if (x < cminX) cminX = x;
    if (x > cmaxX) cmaxX = x;
    const s = row.get(y);
    if (!s) row.set(y, { lo: x, hi: x });
    else { if (x < s.lo) s.lo = x; if (x > s.hi) s.hi = x; }
  }
  const labels = new Int32Array(hw * gh);
  let best: number[] | null = null;
  let bestGap = Infinity;
  for (let y = box.ya; y <= box.yb; y++) {
    for (let x = box.xa; x <= box.xb; x++) {
      const start = y * hw + x;
      if (seen[start] || labels[start] || !(grid[start]! >= floor)) continue;
      const comp: number[] = [];
      const stack = [start];
      labels[start] = 1;
      let minX = x, maxX = x;
      while (stack.length) {
        const p = stack.pop()!;
        comp.push(p);
        const px = p % hw;
        const py = (p / hw) | 0;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        for (let k = 0; k < 8; k++) {
          const nx = px + N8X[k]!;
          const ny = py + N8Y[k]!;
          if (nx < box.xa || ny < box.ya || nx > box.xb || ny > box.yb) continue;
          const q = ny * hw + nx;
          if (seen[q] || labels[q] || !(grid[q]! >= floor)) continue;
          labels[q] = 1;
          stack.push(q);
        }
      }
      if (comp.length < cells.length * 0.22) continue;
      const span = Math.max(1, cmaxX - cminX + 1);
      const overlap = Math.max(0, Math.min(maxX, cmaxX) - Math.max(minX, cminX) + 1);
      if (overlap < span * 0.45) continue;
      let between = 0;
      for (const i of comp) {
        const s = row.get((i / hw) | 0);
        const cx = i % hw;
        if (s && cx > s.lo && cx < s.hi) between++;
      }
      if (between * 2 >= comp.length) continue;
      let gap = Infinity;
      for (const i of comp) {
        const px = i % hw;
        const py = (i / hw) | 0;
        for (const [cx, cy] of cells) {
          const d = Math.max(Math.abs(px - cx), Math.abs(py - cy));
          if (d < gap) gap = d;
          if (gap <= 1) break;
        }
        if (gap <= 1) break;
      }
      if (!(gap <= 3 && gap >= 1)) continue;
      if (!best || comp.length > best.length) { best = comp; bestGap = gap; }
    }
  }
  if (!best || !(bestGap <= 3)) return cells.slice();
  const extra: [number, number][] = [];
  for (const i of best) {
    const x = i % hw;
    const y = (i / hw) | 0;
    const s = row.get(y);
    if (s && x > s.lo && x < s.hi) continue;
    extra.push([x, y]);
  }
  if (extra.length < Math.min(4, cells.length * 0.22)) return cells.slice();
  const union = cells.concat(extra);
  if (lipMassIsStamp(union, box)) return cells.slice();
  let ax = 0, ay = 0, bx = 0, by = 0, gap = Infinity;
  for (const [x, y] of extra) {
    for (const [cx, cy] of cells) {
      const d = Math.max(Math.abs(x - cx), Math.abs(y - cy));
      if (d < gap) { gap = d; ax = cx; ay = cy; bx = x; by = y; }
    }
  }
  const out = cells.slice();
  const have = new Set(out.map(([x, y]) => y * hw + x));
  for (const [x, y] of extra) {
    const i = y * hw + x;
    if (!have.has(i)) { have.add(i); out.push([x, y]); }
  }
  for (const [x, y] of lineCells(ax, ay, bx, by)) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    const i = y * hw + x;
    if (!have.has(i)) { have.add(i); out.push([x, y]); }
  }
  return out;
}

/**
 * Two lip masses already in the cell list, split by a gap of at most two
 * cells, get a 1-cell bridge. Farther masses stay apart (open mouth).
 */
function bridgeCellGaps(
  cells: readonly [number, number][],
  hw: number,
  gh: number,
): [number, number][] {
  if (cells.length < 2 || hw < 1 || gh < 1) return cells.slice();
  const solid = new Uint8Array(hw * gh);
  for (const [x, y] of cells) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    solid[y * hw + x] = 1;
  }
  const labels = new Int32Array(hw * gh);
  const comps: number[][] = [];
  for (let start = 0; start < solid.length; start++) {
    if (!solid[start] || labels[start]) continue;
    const comp: number[] = [];
    const stack = [start];
    labels[start] = comps.length + 1;
    while (stack.length) {
      const p = stack.pop()!;
      comp.push(p);
      const px = p % hw;
      const py = (p / hw) | 0;
      for (let k = 0; k < 4; k++) {
        const nx = px + N4X[k]!;
        const ny = py + N4Y[k]!;
        if (nx < 0 || ny < 0 || nx >= hw || ny >= gh) continue;
        const q = ny * hw + nx;
        if (!solid[q] || labels[q]) continue;
        labels[q] = labels[start]!;
        stack.push(q);
      }
    }
    comps.push(comp);
  }
  if (comps.length < 2) return cells.slice();
  let a = 0;
  let b = 1;
  if ((comps[1]?.length ?? 0) > (comps[0]?.length ?? 0)) { a = 1; b = 0; }
  for (let i = 2; i < comps.length; i++) {
    const n = comps[i]?.length ?? 0;
    if (n > (comps[a]?.length ?? 0)) { b = a; a = i; }
    else if (n > (comps[b]?.length ?? 0)) b = i;
  }
  const A = comps[a] ?? [];
  const B = comps[b] ?? [];
  if (B.length < Math.min(4, A.length * 0.22)) return cells.slice();
  let gap = Infinity;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const ia of A) {
    const x1 = ia % hw;
    const y1 = (ia / hw) | 0;
    for (const ib of B) {
      const x2 = ib % hw;
      const y2 = (ib / hw) | 0;
      const d = Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
      if (d < gap) { gap = d; ax = x1; ay = y1; bx = x2; by = y2; }
    }
  }
  if (!(gap <= 3 && gap >= 1)) return cells.slice();
  const out = cells.slice();
  const have = new Set(out.map(([x, y]) => y * hw + x));
  for (const [x, y] of lineCells(ax, ay, bx, by)) {
    if (x < 0 || y < 0 || x >= hw || y >= gh) continue;
    const i = y * hw + x;
    if (!have.has(i)) { have.add(i); out.push([x, y]); }
  }
  return out;
}

function lipMassOutline(
  cells: ReadonlyArray<readonly [number, number]>,
  sx: number,
  sy: number,
): [number, number][] | null {
  if (cells.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of cells) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const pad = 2;
  const x0 = minX - pad;
  const y0 = minY - pad;
  const w = maxX - minX + 1 + pad * 2;
  const h = maxY - minY + 1 + pad * 2;
  if (!(w >= 3 && h >= 3) || w > 2000 || h > 2000) return null;
  const solid = new Uint8Array(w * h);
  for (const [x, y] of cells) solid[(y - y0) * w + (x - x0)] = 1;
  const mass = joinLipMass(solid, w, h);
  const edge = traceCellEdges(mass, w, h);
  if (!edge || edge.length < 4) return null;
  const nudged = nudgeOutline(edge, mass, w, h);
  // v3b: a sub-8 nudged ring is still the best outline so far - keep it as a
  // candidate instead of discarding it, and always compute the fitted ring too.
  const fitted = fitMassRing(edge, mass, w, h);
  let ring: [number, number][] | null =
    nudged && nudged.length >= 8 ? nudged :
    fitted && fitted.length >= 8 ? fitted :
    nudged && nudged.length >= 3 ? nudged :
    fitted && fitted.length >= 3 ? fitted :
    null;
  if (!ring && edge.length >= 8) {
    const holds = (r: readonly [number, number][]) => massHolds(r, mass, w, h);
    const turns = concaveIdx(edge);
    if (edge.length <= 64 && holds(edge)) ring = edge.map(([x, y]) => [x, y]);
    else {
      for (let n = Math.min(64, edge.length); n >= 8; n -= 4) {
        const sub = subsampleRing(edge, n, turns);
        if (sub.length >= 8 && holds(sub)) { ring = sub; break; }
      }
    }
  }
  if (!ring) ring = nudged ?? fitted;
  if (ring && ring.length >= 3 && ring.length < 8) ring = liftCornerCount(ring);  // v3b: now reachable for 4-7 corner rings
  if (!ring || ring.length < 3) return null;
  if (!(ringArea(ring) > cells.length * 0.2)) return null;
  return ring.map(([x, y]) => [(x + x0) * sx, (y + y0) * sy]);
}

/**
 * Outer cell-edge loop. Interior stays on the left of the walk.
 * A vertex with two exits (the waist of a 1-cell bridge) takes the
 * leftmost turn so the walk keeps the flesh on its left.
 */
function traceCellEdges(solid: Uint8Array, w: number, h: number): [number, number][] | null {
  const on = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
  const key = (x: number, y: number) => `${x},${y}`;
  const next = new Map<string, [number, number][]>();
  const add = (x0: number, y0: number, x1: number, y1: number) => {
    const k = key(x0, y0);
    const list = next.get(k);
    if (list) list.push([x1, y1]);
    else next.set(k, [[x1, y1]]);
  };
  let sx0 = -1, sy0 = -1;
  for (let y = 0; y < h && sx0 < 0; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      sx0 = x;
      sy0 = y;
      break;
    }
  }
  if (sx0 < 0) return null;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!on(x, y)) continue;
      if (!on(x, y - 1)) add(x + 1, y, x, y);
      if (!on(x - 1, y)) add(x, y, x, y + 1);
      if (!on(x, y + 1)) add(x, y + 1, x + 1, y + 1);
      if (!on(x + 1, y)) add(x + 1, y + 1, x + 1, y);
    }
  }
  const ring: [number, number][] = [];
  let x = sx0, y = sy0;
  const guard = w * h * 4 + 8;
  for (let n = 0; n < guard; n++) {
    ring.push([x, y]);
    const opts = next.get(key(x, y));
    if (!opts || opts.length === 0) break;
    let pick = 0;
    if (opts.length > 1 && ring.length >= 2) {
      const prev = ring[ring.length - 2]!;
      const ix = x - prev[0], iy = y - prev[1];
      let best = Infinity;
      for (let i = 0; i < opts.length; i++) {
        const ox = opts[i]![0] - x, oy = opts[i]![1] - y;
        const ang = Math.atan2(ix * oy - iy * ox, ix * ox + iy * oy);
        if (ang < best) { best = ang; pick = i; }
      }
    }
    const nxt = opts.splice(pick, 1)[0]!;
    if (opts.length === 0) next.delete(key(x, y));
    if (nxt[0] === sx0 && nxt[1] === sy0) break;
    x = nxt[0];
    y = nxt[1];
  }
  return ring.length >= 4 ? dedupeRing(ring) : null;
}

function dedupeRing(pts: readonly [number, number][]): [number, number][] {
  const out: [number, number][] = [];
  for (const p of pts) {
    const prev = out[out.length - 1];
    if (prev && prev[0] === p[0] && prev[1] === p[1]) continue;
    out.push([p[0], p[1]]);
  }
  if (out.length >= 2) {
    const a = out[0]!, b = out[out.length - 1]!;
    if (a[0] === b[0] && a[1] === b[1]) out.pop();
  }
  return out;
}

function ringHolds(poly: readonly [number, number][], x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i]![0], yi = poly[i]![1], xj = poly[j]![0], yj = poly[j]![1];
    const dy = yj - yi;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (dy === 0 ? 1e-12 : dy) + xi)) hit = !hit;
  }
  return hit;
}

/**
 * Edge offset. dist is in cells. `side` picks the normal; the caller tries
 * both because area sign and winding cancel if you flip them together.
 * A long miter becomes a bevel so a notch cannot spike.
 */
function offsetClosed(pts: readonly [number, number][], dist: number, side: 1 | -1): [number, number][] {
  const n = pts.length;
  if (n < 3 || !(dist > 0)) return pts.map(([x, y]) => [x, y]);
  const cap = dist * 1.35;
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const prev = pts[(i + n - 1) % n]!;
    const cur = pts[i]!;
    const next = pts[(i + 1) % n]!;
    let ax = cur[0] - prev[0], ay = cur[1] - prev[1];
    let bx = next[0] - cur[0], by = next[1] - cur[1];
    const al = Math.hypot(ax, ay) || 1;
    const bl = Math.hypot(bx, by) || 1;
    ax /= al; ay /= al; bx /= bl; by /= bl;
    const nax = -ay * side, nay = ax * side;
    const nbx = -by * side, nby = bx * side;
    let nx = nax + nbx, ny = nay + nby;
    const nl = Math.hypot(nx, ny);
    if (nl < 1e-6) {
      out.push([cur[0] + nax * dist, cur[1] + nay * dist]);
      continue;
    }
    nx /= nl; ny /= nl;
    const denom = nax * nx + nay * ny;
    const miter = denom > 0.2 ? dist / denom : cap + 1;
    if (miter > cap) {
      out.push([cur[0] + nax * dist, cur[1] + nay * dist]);
      out.push([cur[0] + nbx * dist, cur[1] + nby * dist]);
    } else {
      out.push([cur[0] + nx * miter, cur[1] + ny * miter]);
    }
  }
  return out;
}

/**
 * Nudge the cell-edge loop out by a fraction of a cell. Filled corners stay
 * inside. Centers of empty 4-neighbors stay outside, so a notch one cell
 * away is not covered and the outline does not grow a skirt.
 */
function nudgeOutline(
  edge: readonly [number, number][],
  solid: Uint8Array,
  w: number,
  h: number,
): [number, number][] | null {
  const filled: [number, number][] = [];
  const empty: [number, number][] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid[y * w + x]) continue;
      filled.push([x + 0.5, y + 0.5]);
      // 0.15 sits outside the cell edge, so the accepted ring has moved out.
      // 0.5 is the next cell's center and must stay empty (no skirt).
      if (!solidAt(solid, w, h, x, y - 1)) {
        filled.push([x + 0.5, y - 0.15]);
        empty.push([x + 0.5, y - 0.5]);
      }
      if (!solidAt(solid, w, h, x, y + 1)) {
        filled.push([x + 0.5, y + 1.15]);
        empty.push([x + 0.5, y + 1.5]);
      }
      if (!solidAt(solid, w, h, x - 1, y)) {
        filled.push([x - 0.15, y + 0.5]);
        empty.push([x - 0.5, y + 0.5]);
      }
      if (!solidAt(solid, w, h, x + 1, y)) {
        filled.push([x + 1.15, y + 0.5]);
        empty.push([x + 1.5, y + 0.5]);
      }
    }
  }
  const holds = (ring: readonly [number, number][]) => {
    if (ring.length < 3 || !(ringArea(ring) > 0)) return false;
    for (const [x, y] of filled) if (!ringHolds(ring, x, y)) return false;
    for (const [x, y] of empty) if (ringHolds(ring, x, y)) return false;
    return true;
  };
  // One winding, both normal signs. Reversing the ring and the sign together
  // offsets inward twice and the hull fallback fills the cupid notch.
  const base = dropCollinear(edge);
  let chosen: [number, number][] | null = null;
  for (const side of [1, -1] as const) {
    for (const dist of [0.24, 0.32, 0.4]) {
      const ring = offsetClosed(base, dist, side);
      if (holds(ring)) { chosen = ring; break; }
    }
    if (chosen) break;
  }
  if (!chosen) return null;
  return fitContained(chosen, holds);
}

/** Same polygon, enough corners that a flat ellipse is not a 7-point hull. */
function liftCornerCount(ring: readonly [number, number][]): [number, number][] {
  const pts = ring.map(([x, y]) => [x, y] as [number, number]);
  while (pts.length < 8) {
    let best = 0;
    let bestLen = -1;
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i]!;
      const b = pts[(i + 1) % pts.length]!;
      const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (d > bestLen) { bestLen = d; best = i; }
    }
    const a = pts[best]!;
    const b = pts[(best + 1) % pts.length]!;
    pts.splice(best + 1, 0, [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]);
  }
  return pts;
}

function solidAt(solid: Uint8Array, w: number, h: number, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < w && y < h && solid[y * w + x] === 1;
}

function dropCollinear(pts: readonly [number, number][]): [number, number][] {
  const n = pts.length;
  if (n <= 3) return pts.map(([x, y]) => [x, y]);
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (Math.abs(cross) > 1e-6) out.push([b[0], b[1]]);
  }
  return out.length >= 3 ? out : pts.map(([x, y]) => [x, y]);
}

function fitContained(
  ring: readonly [number, number][],
  holds: (poly: readonly [number, number][]) => boolean,
): [number, number][] | null {
  const trimmed = dropCollinear(ring);
  if (trimmed.length <= 64 && holds(trimmed)) return trimmed;
  if (ring.length <= 64 && holds(ring)) return ring.map(([x, y]) => [x, y]);
  for (let n = 64; n >= 16; n -= 4) {
    if (n >= ring.length) continue;
    const sub = subsampleRing(ring, n);
    if (holds(sub)) return sub;
  }
  // A subsample that fails containment fills the cupid notch. Keep the ring.
  if (holds(ring)) return ring.map(([x, y]) => [x, y]);
  return null;
}

function subsampleRing(
  ring: readonly [number, number][],
  n: number,
  extra?: readonly number[],
): [number, number][] {
  if (ring.length <= n) return ring.map(([x, y]) => [x, y]);
  let iMinX = 0, iMaxX = 0, iMinY = 0, iMaxY = 0;
  for (let i = 1; i < ring.length; i++) {
    const p = ring[i]!;
    if (p[0] < ring[iMinX]![0]) iMinX = i;
    if (p[0] > ring[iMaxX]![0]) iMaxX = i;
    if (p[1] < ring[iMinY]![1]) iMinY = i;
    if (p[1] > ring[iMaxY]![1]) iMaxY = i;
  }
  const want = new Set<number>([iMinX, iMaxX, iMinY, iMaxY]);
  if (extra) {
    for (const i of extra) {
      if (i >= 0 && i < ring.length && want.size < n) want.add(i);
    }
  }
  const step = ring.length / n;
  for (let i = 0; i < n && want.size < n; i++) want.add(Math.floor(i * step));
  const order = [...want].sort((a, b) => a - b);
  const out: [number, number][] = [];
  for (const i of order) out.push(ring[i]!);
  return out.length >= 3 ? out : ring.slice(0, n).map(([x, y]) => [x, y]);
}

/** Right turns on an interior-left walk: the cupid notch and commissure waists. */
function concaveIdx(pts: readonly [number, number][]): number[] {
  const n = pts.length;
  const scored: { i: number; turn: number }[] = [];
  for (let i = 0; i < n; i++) {
    const a = pts[(i + n - 1) % n]!;
    const b = pts[i]!;
    const c = pts[(i + 1) % n]!;
    const cross = (b[0] - a[0]) * (c[1] - b[1]) - (b[1] - a[1]) * (c[0] - b[0]);
    if (cross < -0.5) scored.push({ i, turn: -cross });
  }
  scored.sort((p, q) => q.turn - p.turn);
  const out: number[] = [];
  for (let i = 0; i < scored.length && out.length < 24; i++) out.push(scored[i]!.i);
  return out;
}

function massHolds(
  ring: readonly [number, number][],
  solid: Uint8Array,
  w: number,
  h: number,
): boolean {
  if (ring.length < 3 || !(ringArea(ring) > 0)) return false;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!solid[y * w + x]) continue;
      if (!ringHolds(ring, x + 0.5, y + 0.5)) return false;
      if (!solidAt(solid, w, h, x, y - 1) && ringHolds(ring, x + 0.5, y - 0.5)) return false;
      if (!solidAt(solid, w, h, x, y + 1) && ringHolds(ring, x + 0.5, y + 1.5)) return false;
      if (!solidAt(solid, w, h, x - 1, y) && ringHolds(ring, x - 0.5, y + 0.5)) return false;
      if (!solidAt(solid, w, h, x + 1, y) && ringHolds(ring, x + 1.5, y + 0.5)) return false;
    }
  }
  return true;
}

/** Cell-edge ring when the outward nudge collapses to a blocky hull. */
function fitMassRing(
  edge: readonly [number, number][],
  solid: Uint8Array,
  w: number,
  h: number,
): [number, number][] | null {
  const base = dropCollinear(edge);
  const holds = (ring: readonly [number, number][]) => massHolds(ring, solid, w, h);
  if (!holds(base)) return null;
  if (base.length >= 8 && base.length <= 64) return base;
  if (base.length < 8) return null;
  const turns = concaveIdx(base);
  for (let n = 64; n >= 16; n -= 4) {
    const sub = subsampleRing(base, n, turns);
    if (sub.length >= 8 && sub.length <= 64 && holds(sub)) return sub;
  }
  return base.length >= 8 ? base : null;
}

const N4X = [1, 0, -1, 0];
const N4Y = [0, 1, 0, -1];
const N8X = [1, 1, 0, -1, -1, -1, 0, 1];
const N8Y = [0, 1, 1, 1, 0, -1, -1, -1];

function labelMass(solid: Uint8Array, w: number, h: number): { labels: Int32Array; sizes: number[] } {
  const labels = new Int32Array(w * h);
  const sizes: number[] = [0];
  for (let i = 0; i < solid.length; i++) {
    if (!solid[i] || labels[i]) continue;
    const id = sizes.length;
    const stack = [i];
    labels[i] = id;
    let n = 0;
    while (stack.length) {
      const p = stack.pop()!;
      n += 1;
      const x = p % w;
      const y = (p / w) | 0;
      for (let k = 0; k < 8; k++) {
        const nx = x + N8X[k]!;
        const ny = y + N8Y[k]!;
        if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
        const q = ny * w + nx;
        if (!solid[q] || labels[q]) continue;
        labels[q] = id;
        stack.push(q);
      }
    }
    sizes.push(n);
  }
  return { labels, sizes };
}

/**
 * Largest redness mass. A second mass within a 2-cell gap (the other lip)
 * is joined by a 1-cell bridge. The bridge stays inside the union, so the
 * outer edge does not grow.
 * ponytail: a wider gap stays split and only the larger mass is kept
 * (open mouth). Upgrade path: emit the second mass as its own subpath.
 */
function joinLipMass(solid: Uint8Array, w: number, h: number): Uint8Array {
  const { labels, sizes } = labelMass(solid, w, h);
  if (sizes.length <= 2) return solid;
  let best = 1;
  for (let i = 2; i < sizes.length; i++) if ((sizes[i] ?? 0) > (sizes[best] ?? 0)) best = i;
  let second = 0;
  for (let i = 1; i < sizes.length; i++) {
    if (i === best) continue;
    if ((sizes[i] ?? 0) < (sizes[best] ?? 0) * 0.22) continue;
    if (!second || (sizes[i] ?? 0) > (sizes[second] ?? 0)) second = i;
  }
  const keep = new Uint8Array(w * h);
  for (let i = 0; i < labels.length; i++) if (labels[i] === best) keep[i] = 1;
  if (!second) return keep;
  const A: number[] = [];
  const B: number[] = [];
  for (let i = 0; i < labels.length; i++) {
    if (labels[i] === best) A.push(i);
    else if (labels[i] === second) B.push(i);
  }
  let gap = Infinity;
  let ax = 0, ay = 0, bx = 0, by = 0;
  for (const ia of A) {
    const x1 = ia % w;
    const y1 = (ia / w) | 0;
    for (const ib of B) {
      const x2 = ib % w;
      const y2 = (ib / w) | 0;
      const d = Math.max(Math.abs(x1 - x2), Math.abs(y1 - y2));
      if (d < gap) { gap = d; ax = x1; ay = y1; bx = x2; by = y2; }
    }
  }
  if (!(gap <= 3)) return keep;
  for (let i = 0; i < labels.length; i++) if (labels[i] === second) keep[i] = 1;
  let x = ax, y = ay;
  const dx = Math.abs(bx - ax), dy = Math.abs(by - ay);
  const sxn = ax < bx ? 1 : -1, syn = ay < by ? 1 : -1;
  let err = dx - dy;
  for (let n = 0; n <= dx + dy; n++) {
    if (x >= 0 && y >= 0 && x < w && y < h) keep[y * w + x] = 1;
    if (x === bx && y === by) break;
    const e2 = 2 * err;
    if (e2 > -dy) { err -= dy; x += sxn; }
    if (e2 < dx) { err += dx; y += syn; }
  }
  return keep;
}

function ringArea(pts: ReadonlyArray<readonly [number, number]>): number {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    a += pts[j]![0] * pts[i]![1] - pts[i]![0] * pts[j]![1];
  }
  return Math.abs(a) / 2;
}

function convexHull(pts: ReadonlyArray<readonly [number, number]>): [number, number][] {
  const uniq = new Map<string, [number, number]>();
  for (const [x, y] of pts) uniq.set(`${x.toFixed(1)},${y.toFixed(1)}`, [x, y]);
  const p = [...uniq.values()].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (p.length < 3) return p;
  const cross = (o: [number, number], a: [number, number], b: [number, number]) =>
    (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2]!, lower[lower.length - 1]!, pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper: [number, number][] = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i]!;
    while (upper.length >= 2 && cross(upper[upper.length - 2]!, upper[upper.length - 1]!, pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

/**
 * Pick the faceBox: model when available and confident, else the skin-grid
 * heuristic candidate (already shaped), else the centered portrait prior.
 * Everything is clamped; a null model/skin candidate just falls through.
 */
export function decideFaceBox(
  model: { box: FaceBox; conf: number } | null,
  skin: FaceBox | null,
): FaceBoxDecision {
  if (model && model.conf >= 0.5) {
    const fills = model.conf >= 0.65 && model.box.h >= 0.6;
    const clamped = clampFaceBox(model.box, { faceFillsFrame: fills });
    if (clamped) return { faceBox: clamped, source: "model", confident: true };
  }
  if (skin) {
    const clamped = clampFaceBox(skin);
    if (clamped) return { faceBox: clamped, source: "skin", confident: true };
  }
  return { faceBox: portraitPriorFaceBox(), source: "prior", confident: false };
}
