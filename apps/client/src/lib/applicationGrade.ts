/**
 * Application grading: is she applying it where the chart says?
 *
 * The mirror already tracks her face; product going on changes pixels inside
 * the mesh zones. At each lesson step we baseline the target zones (she
 * hasn't applied THIS step yet), then sample periodically:
 *
 *   delta metric per step kind — blush: redness rise; shade: luminance
 *   drop; light: luminance rise.
 *   coverage  = fraction of in-zone sample points past threshold
 *   overflow  = fraction of a ring OUTSIDE the zone past threshold
 *               (product placed too wide)
 *   centroid offset = where the product landed vs the zone center
 *                ("a little higher", "toward the temple")
 *
 * Pure functions over sample-point colors — the browser side just feeds
 * [r,g,b] per point. Unit-testable without a camera.
 */

export type StepKind = "contour" | "blush" | "highlight";

export interface Pt {
  x: number;
  y: number;
}

/** Sample grid for a polygon: bbox grid points that fall inside the poly. */
export function gridInPoly(poly: Pt[], step = 16): Pt[] {
  const xs = poly.map((p) => p.x);
  const ys = poly.map((p) => p.y);
  const x0 = Math.min(...xs), x1 = Math.max(...xs);
  const y0 = Math.min(...ys), y1 = Math.max(...ys);
  const out: Pt[] = [];
  for (let y = y0; y <= y1; y += 1 / step) {
    for (let x = x0; x <= x1; x += 1 / step) {
      if (pointIn(x, y, poly)) out.push({ x, y });
    }
  }
  return out.length ? out : [{ x: (x0 + x1) / 2, y: (y0 + y1) / 2 }];
}

/** Ring of points just OUTSIDE the polygon (overflow detector). */
export function ringAroundPoly(poly: Pt[], step = 16, pad = 0.03): Pt[] {
  const cx = poly.reduce((a, p) => a + p.x, 0) / poly.length;
  const cy = poly.reduce((a, p) => a + p.y, 0) / poly.length;
  const expanded = poly.map((p) => {
    const dx = p.x - cx, dy = p.y - cy;
    const len = Math.hypot(dx, dy) || 1;
    return { x: p.x + (dx / len) * pad, y: p.y + (dy / len) * pad };
  });
  // strictly outside the ORIGINAL polygon (geometric test, not key-matching)
  return gridInPoly(expanded, step).filter((p) => !pointIn(p.x, p.y, poly));
}

function pointIn(x: number, y: number, poly: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!, pj = poly[j]!;
    if (pi.y > y === pj.y > y) continue;
    if (x < ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x) inside = !inside;
  }
  return inside;
}

export type RGB = readonly [number, number, number];

const luminance = (c: RGB) => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
const redness = (c: RGB) => c[0] - Math.max(c[1], c[2]) - Math.abs(c[1] - c[2]) * 0.25;

/** Signed strength of product for a kind, from a before/after color pair. */
export function deltaMetric(kind: StepKind, before: RGB, after: RGB): number {
  if (kind === "blush") return redness(after) - redness(before);
  if (kind === "contour") return luminance(before) - luminance(after); // darker = product
  return luminance(after) - luminance(before); // highlight: brighter
}

/** Per-kind thresholds: how much metric change counts as product present. */
export const DELTA_THR: Record<StepKind, number> = {
  blush: 10,
  contour: 12,
  highlight: 10,
};

export interface GradeSample {
  /** 0..1 fraction of in-zone points carrying product. */
  coverage: number;
  /** 0..1 fraction of outside-ring points carrying product (too wide). */
  overflow: number;
  /** Centroid of applied product minus zone centroid, normalized units. */
  offset: Pt;
  score: number;
  feedback: string;
}

export interface ZoneGradeInput {
  kind: StepKind;
  /** Zone polygon, normalized coords. */
  poly: Pt[];
  /** Sample-point colors at baseline (aligned with `inside` points). */
  baselineInside: RGB[];
  /** Current colors at the same points. */
  currentInside: RGB[];
  baselineRing: RGB[];
  currentRing: RGB[];
}

/**
 * Directional phrase telling her WHERE TO ADD: the hint names the opposite
 * of the centroid offset (product sitting high -> "a touch lower" is where
 * more goes). dy negative = product above zone center.
 */
export function placementHint(offset: Pt): string {
  const ax = Math.abs(offset.x), ay = Math.abs(offset.y);
  if (ay > ax && offset.y < -0.012) return "a touch lower";
  if (ay > ax && offset.y > 0.012) return "a touch higher";
  if (ax >= ay && offset.x > 0.012) return "keep it a little further in";
  if (ax >= ay && offset.x < -0.012) return "sweep it a little further out";
  return "";
}

export function gradeZone(z: ZoneGradeInput): GradeSample {
  const thr = DELTA_THR[z.kind];
  const insidePts = gridInPoly(z.poly);
  const zoneCx = z.poly.reduce((a, p) => a + p.x, 0) / z.poly.length;
  const zoneCy = z.poly.reduce((a, p) => a + p.y, 0) / z.poly.length;

  let covered = 0;
  let sx = 0, sy = 0, wsum = 0;
  const n = Math.min(insidePts.length, z.baselineInside.length, z.currentInside.length);
  for (let i = 0; i < n; i++) {
    const d = deltaMetric(z.kind, z.baselineInside[i]!, z.currentInside[i]!);
    if (d > thr) {
      covered++;
      const w = Math.min(d, thr * 4);
      sx += insidePts[i]!.x * w;
      sy += insidePts[i]!.y * w;
      wsum += w;
    }
  }
  const coverage = n ? covered / n : 0;

  let ringHit = 0;
  const rn = Math.min(z.baselineRing.length, z.currentRing.length);
  for (let i = 0; i < rn; i++) {
    const d = deltaMetric(z.kind, z.baselineRing[i]!, z.currentRing[i]!);
    if (d > thr) ringHit++;
  }
  const overflow = rn ? ringHit / rn : 0;

  const offset = wsum > 0 ? { x: sx / wsum - zoneCx, y: sy / wsum - zoneCy } : { x: 0, y: 0 };

  // Score: coverage dominates; overflow and drift pull it down.
  let score = coverage;
  score -= Math.min(0.25, overflow * 0.5);
  const drift = Math.hypot(offset.x, offset.y);
  score -= Math.min(0.15, drift * 1.2);
  score = Math.max(0, Math.min(1, score));

  let feedback: string;
  if (coverage === 0) feedback = "Watch the path, then paint along it";
  else if (coverage < 0.2) feedback = "not yet — follow the sweep";
  else if (overflow > 0.5) feedback = "lighter hand — stay inside the glow";
  else if (coverage >= 0.85) feedback = "that's it — blended right";
  else {
    const hint = placementHint(offset);
    if (hint) feedback = coverage < 0.5 ? `${hint} — keep building` : `almost — ${hint}`;
    else feedback = coverage < 0.5 ? "good start, keep building along the path" : "almost — fill the whole glow";
  }

  return { coverage, overflow, offset, score, feedback };
}
