/**
 * Coach measurements: the ~7 scalar indices from the 478-pt mesh.
 *
 * Spec: docs/FACE-GEOMETRY.md section 3. Input is the fractional 4:5
 * landmark array as produced by faceMesh.ts (faceLandmarks[0] order).
 * All math runs in a normalized frontal reference frame (section 2):
 *   1. roll: the outer-eye-corner line 33 -> 263 is rotated horizontal
 *   2. scale: every coord is divided by the interocular distance (33 <-> 263)
 *   3. yaw gate: nose tip (4) offset from the 234 <-> 454 midpoint, as a
 *      fraction of face width, beyond 6% -> refuse (null), the caller shows
 *      "face the mirror" rather than mis-charting a 3/4 face
 *
 * Pure functions, deterministic, no DOM. Angles are degrees.
 */

/** One mesh landmark: fractional x/y in the 4:5 frame, z unused here. */
export interface CoachPoint {
  x: number;
  y: number;
  z?: number;
}

/** The scalar measurement set from FACE-GEOMETRY.md section 3. */
export interface FaceMeasurements {
  /** face length: 10 -> 152 */
  FL: number;
  /** cheekbone width: 127 <-> 356 */
  CW: number;
  /** jaw width: 172 <-> 397 */
  JW: number;
  /** forehead/temple width: 103 <-> 332 */
  FW: number;
  /** mouth width: 61 <-> 291 */
  MW: number;
  /** length proportion FL / CW */
  FLPR: number;
  /** jaw balance JW / CW */
  JBR: number;
  /** forehead balance FW / JW */
  FBR: number;
  /** hairline width ratio FW / CW; forehead versus cheekbone */
  HWR: number;
  /** jaw corner angularity, deg; average of both jaw-corner angles */
  jawAng: number;
  /** chin pointedness, deg; angle at 152 between 172 and 397 */
  chinAng: number;
}

/** Result of normalization: rotated/scaled points plus the gate decision. */
export interface NormalizedFace {
  points: Map<number, { x: number; y: number }>;
  /** deg, the roll that was removed (positive = eye line sloped down L->R) */
  rollDeg: number;
  /** interocular distance in frame fractions before scaling */
  iod: number;
  /** |nose tip offset from ear midpoint| / face width; yaw proxy */
  yawOffset: number;
}

/** Yaw gate: beyond 6% of face width the face is not frontal. */
export const YAW_GATE = 0.06;

/** Jaw-corner neighbor indices on the face-oval loop (172's and 397's neighbors). */
const JAW_NEIGHBORS = { left: [136, 58] as const, right: [288, 365] as const };

export const MEASURE_INDICES = {
  foreheadTop: 10,
  chin: 152,
  cheekL: 127,
  cheekR: 356,
  jawL: 172,
  jawR: 397,
  templeL: 103,
  templeR: 332,
  mouthL: 61,
  mouthR: 291,
  eyeOuterL: 33,
  eyeOuterR: 263,
  noseTip: 4,
  earL: 234,
  earR: 454,
} as const;

/** Landmark indices the measurement set reads; a face missing any is refused. */
const REQUIRED = [
  MEASURE_INDICES.foreheadTop, MEASURE_INDICES.chin,
  MEASURE_INDICES.cheekL, MEASURE_INDICES.cheekR,
  MEASURE_INDICES.jawL, MEASURE_INDICES.jawR,
  MEASURE_INDICES.templeL, MEASURE_INDICES.templeR,
  MEASURE_INDICES.mouthL, MEASURE_INDICES.mouthR,
  MEASURE_INDICES.eyeOuterL, MEASURE_INDICES.eyeOuterR,
  MEASURE_INDICES.noseTip, MEASURE_INDICES.earL, MEASURE_INDICES.earR,
  ...JAW_NEIGHBORS.left, ...JAW_NEIGHBORS.right,
] as const;

function get(points: Map<number, { x: number; y: number }>, i: number): { x: number; y: number } {
  const p = points.get(i);
  if (!p) throw new Error(`landmark ${i} missing`);
  return p;
}

function dist(points: Map<number, { x: number; y: number }>, a: number, b: number): number {
  const pa = get(points, a);
  const pb = get(points, b);
  return Math.hypot(pa.x - pb.x, pa.y - pb.y);
}

/** Angle at vertex `v` between the vectors to `a` and `b`, in degrees. */
function angleAt(points: Map<number, { x: number; y: number }>, v: number, a: number, b: number): number {
  const pv = get(points, v);
  const pa = get(points, a);
  const pb = get(points, b);
  const v1x = pa.x - pv.x, v1y = pa.y - pv.y;
  const v2x = pb.x - pv.x, v2y = pb.y - pv.y;
  const m = Math.hypot(v1x, v1y) * Math.hypot(v2x, v2y);
  if (m === 0) return 180;
  const d = (v1x * v2x + v1y * v2y) / m;
  return (Math.acos(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

/**
 * Normalize to the frontal reference frame: roll-fix on the eye line, scale
 * by interocular distance, measure the yaw proxy. Does not mutate input.
 */
export function normalizeFace(landmarks: readonly CoachPoint[]): NormalizedFace | null {
  const at = (i: number): { x: number; y: number } | null => {
    const p = landmarks[i];
    return p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null;
  };
  for (const i of REQUIRED) if (!at(i)) return null;

  const eL = at(MEASURE_INDICES.eyeOuterL)!;
  const eR = at(MEASURE_INDICES.eyeOuterR)!;
  const roll = Math.atan2(eR.y - eL.y, eR.x - eL.x);
  const iod = Math.hypot(eR.x - eL.x, eR.y - eL.y);
  if (iod <= 1e-6) return null;

  const cos = Math.cos(-roll);
  const sin = Math.sin(-roll);
  const points = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < landmarks.length; i++) {
    const p = at(i);
    if (p) {
      points.set(i, { x: (p.x * cos - p.y * sin) / iod, y: (p.x * sin + p.y * cos) / iod });
    }
  }

  const earMidX = (get(points, MEASURE_INDICES.earL).x + get(points, MEASURE_INDICES.earR).x) / 2;
  const faceW = dist(points, MEASURE_INDICES.earL, MEASURE_INDICES.earR);
  if (!(faceW > 0)) return null;
  const yawOffset = Math.abs(get(points, MEASURE_INDICES.noseTip).x - earMidX) / faceW;

  return { points, rollDeg: (roll * 180) / Math.PI, iod, yawOffset };
}

/**
 * The section 3 measurement set on an already-normalized face. Returns null
 * on the yaw gate (not frontal), a zero width, or a non-finite ratio.
 * Callers refuse to classify.
 */
export function measureFace(landmarks: readonly CoachPoint[]): FaceMeasurements | null {
  const norm = normalizeFace(landmarks);
  if (!norm || norm.yawOffset > YAW_GATE) return null;
  const pts = norm.points;

  const FL = dist(pts, MEASURE_INDICES.foreheadTop, MEASURE_INDICES.chin);
  const CW = dist(pts, MEASURE_INDICES.cheekL, MEASURE_INDICES.cheekR);
  const JW = dist(pts, MEASURE_INDICES.jawL, MEASURE_INDICES.jawR);
  const FW = dist(pts, MEASURE_INDICES.templeL, MEASURE_INDICES.templeR);
  const MW = dist(pts, MEASURE_INDICES.mouthL, MEASURE_INDICES.mouthR);
  if (!(FL > 0 && CW > 0 && JW > 0 && FW > 0 && MW > 0)) return null;

  // Jaw corner angularity: at 172 (and mirrored 397), the angle between the
  // vectors to the two neighboring contour points and the chin (152).
  // PIN: spec says "neighbor contour pts" without naming them; the oval-loop
  // neighbors (136/58 left, 288/365 right) are used. Revisit at the
  // pin-the-indices probe (demos/render-landmarks.mjs).
  const [nl1, nl2] = JAW_NEIGHBORS.left;
  const [nr1, nr2] = JAW_NEIGHBORS.right;
  const aL = angleAt(pts, MEASURE_INDICES.jawL, nl1, nl2) / 2 + angleAt(pts, MEASURE_INDICES.jawL, nl1, MEASURE_INDICES.chin) / 2;
  const aR = angleAt(pts, MEASURE_INDICES.jawR, nr1, nr2) / 2 + angleAt(pts, MEASURE_INDICES.jawR, nr2, MEASURE_INDICES.chin) / 2;
  const jawAng = (aL + aR) / 2;
  const chinAng = angleAt(pts, MEASURE_INDICES.chin, MEASURE_INDICES.jawL, MEASURE_INDICES.jawR);
  const FLPR = FL / CW;
  const JBR = JW / CW;
  const FBR = FW / JW;
  const HWR = FW / CW;
  if (![FLPR, JBR, FBR, HWR, jawAng, chinAng].every(Number.isFinite)) return null;

  return {
    FL, CW, JW, FW, MW,
    FLPR, JBR, FBR, HWR, jawAng, chinAng,
  };
}
