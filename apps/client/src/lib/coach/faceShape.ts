/**
 * Face-shape classification: nine-label cascade, first match wins.
 *
 * Labels: oval, round, square, pear, heart, diamond, oblong, rectangle,
 * invTriangle. long maps to oblong; triangle maps to pear. The hairline
 * branch is HWR = FW/CW (stored on the measurement): a long angular face
 * whose hairline stays near the cheek width is rectangle, and a narrow jaw
 * under a wide hairline is invTriangle rather than heart or oblong.
 *
 * Spec: docs/FACE-GEOMETRY.md section 4. Pure function over coach/measure.ts;
 * thresholds live in thresholds.json (placeholder until WFLW calibration).
 * Every rule records its margin: the runner-up becomes the secondary shape
 * and confidence is the normalized margin. Nothing matched, or a yaw-gated
 * null, is balanced/oval - never a thrown error.
 */

import thresholdsJson from "./thresholds.json" with { type: "json" };
import type { FaceMeasurements } from "./measure.ts";

export const FACE_SHAPES = [
  "oval",
  "round",
  "square",
  "pear",
  "heart",
  "diamond",
  "oblong",
  "rectangle",
  "invTriangle",
] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

/** JSON shape of thresholds.json (kept narrow on purpose). */
export interface Thresholds {
  version: number;
  calibration: string;
  FLPR: { oblongMin: number; roundMax: number; squareMax: number };
  jawAng: { roundMinDeg: number; squareMaxDeg: number };
  JBR: { squareMin: number };
  FBR: { heartMin: number };
  /** Hairline branch. invTriangleMin: forehead wider than cheeks. rectangleMin/Max: hairline near cheek width. */
  HWR: { invTriangleMin: number; rectangleMin: number; rectangleMax: number };
  pear: { jawOverForehead: number };
  diamond: { cheekOverForehead: number; cheekOverJaw: number; chinPointedMaxDeg: number };
}

export const thresholds: Thresholds = thresholdsJson as unknown as Thresholds;

export interface Classification {
  primary: FaceShape;
  secondary: FaceShape;
  /** 0..1 normalized margin of the winning rule; low = borderline face. */
  confidence: number;
  /** Per-rule margins: how far `m` sits inside (positive) or outside (negative) each rule. */
  margins: Partial<Record<FaceShape, number>>;
}

interface Rule {
  shape: FaceShape;
  /** Positive when the rule matches; magnitude = slack inside the rule. */
  margin: (m: FaceMeasurements) => number;
}

/** ponytail: divide ratios by 0.1 and degrees by 10 before Math.min, until WFLW writes thresholds.json. */
const RATIO_UNIT = 0.1;
const DEG_UNIT = 10;

/** Non-finite input loses the rule instead of becoming NaN and sorting as a win. */
function slack(delta: number, unit: number): number {
  return Number.isFinite(delta) ? delta / unit : Number.NEGATIVE_INFINITY;
}

/**
 * Prefer the measured HWR. A non-finite value falls back to FW/CW, the same
 * ratio measure.ts stores, so a dropped field still takes the hairline branch.
 */
function hairline(m: FaceMeasurements): number {
  if (Number.isFinite(m.HWR)) return m.HWR;
  if (Number.isFinite(m.FW) && Number.isFinite(m.CW) && m.CW > 0) return m.FW / m.CW;
  return Number.NaN;
}

/**
 * Hairline branch, in normalized slack. Non-negative when the forehead is wider
 * than the cheeks and the jaw is narrower than the forehead: invTriangle.
 * Oblong uses the same value so a long face cannot skip both rules.
 */
function hairlineBranch(m: FaceMeasurements): number {
  return Math.min(
    slack(hairline(m) - thresholds.HWR.invTriangleMin, RATIO_UNIT),
    slack(m.FBR - thresholds.FBR.heartMin, RATIO_UNIT),
  );
}

/**
 * Ordered cascade. Margins are normalized slack (see RATIO_UNIT / DEG_UNIT).
 * First non-negative margin wins (boundaries are inclusive: >=, <=).
 * Rectangle reuses the square jaw knobs; it is the long face with a square jaw
 * and a hairline near the cheek width.
 */
const CASCADE: Rule[] = [
  {
    shape: "rectangle",
    margin: (m) => {
      const h = hairline(m);
      return Math.min(
        slack(m.FLPR - thresholds.FLPR.oblongMin, RATIO_UNIT),
        slack(thresholds.jawAng.squareMaxDeg - m.jawAng, DEG_UNIT),
        slack(m.JBR - thresholds.JBR.squareMin, RATIO_UNIT),
        slack(h - thresholds.HWR.rectangleMin, RATIO_UNIT),
        slack(thresholds.HWR.rectangleMax - h, RATIO_UNIT),
      );
    },
  },
  {
    shape: "oblong",
    margin: (m) => {
      const length = slack(m.FLPR - thresholds.FLPR.oblongMin, RATIO_UNIT);
      if (!(length >= 0)) return length;
      const branch = hairlineBranch(m);
      // -0 would still count as a match, so the yield is strictly negative.
      if (branch >= 0) return -Math.max(branch, Number.MIN_VALUE);
      return length;
    },
  },
  {
    shape: "round",
    margin: (m) => Math.min(
      slack(thresholds.FLPR.roundMax - m.FLPR, RATIO_UNIT),
      slack(m.jawAng - thresholds.jawAng.roundMinDeg, DEG_UNIT),
    ),
  },
  {
    shape: "square",
    margin: (m) => Math.min(
      slack(thresholds.FLPR.squareMax - m.FLPR, RATIO_UNIT),
      slack(thresholds.jawAng.squareMaxDeg - m.jawAng, DEG_UNIT),
      slack(m.JBR - thresholds.JBR.squareMin, RATIO_UNIT),
    ),
  },
  { shape: "invTriangle", margin: (m) => hairlineBranch(m) },
  { shape: "heart", margin: (m) => slack(m.FBR - thresholds.FBR.heartMin, RATIO_UNIT) },
  { shape: "pear", margin: (m) => slack(m.JW - m.FW * thresholds.pear.jawOverForehead, RATIO_UNIT) },
  {
    shape: "diamond",
    margin: (m) => Math.min(
      slack(m.CW - m.FW * thresholds.diamond.cheekOverForehead, RATIO_UNIT),
      slack(m.CW - m.JW * thresholds.diamond.cheekOverJaw, RATIO_UNIT),
      slack(thresholds.diamond.chinPointedMaxDeg - m.chinAng, DEG_UNIT),
    ),
  },
];

/**
 * Classify. Null measurements (yaw-gated or degenerate) classify as
 * balanced/oval with zero confidence.
 */
export function classifyFace(m: FaceMeasurements | null): Classification {
  if (!m) {
    return { primary: "oval", secondary: "oval", confidence: 0, margins: {} };
  }

  const margins: Partial<Record<FaceShape, number>> = {};
  for (const rule of CASCADE) margins[rule.shape] = rule.margin(m);

  const winner = CASCADE.find((r) => (margins[r.shape] ?? Number.NEGATIVE_INFINITY) >= 0);
  if (!winner) {
    // A rule that could not be evaluated must not look like a balanced oval.
    const blind = CASCADE.some((r) => !Number.isFinite(margins[r.shape]));
    return { primary: "oval", secondary: "oval", confidence: blind ? 0 : 0.5, margins };
  }

  const scored = CASCADE.filter((r) => r !== winner).map((r) => ({
    shape: r.shape,
    score: margins[r.shape] ?? Number.NEGATIVE_INFINITY,
  }));
  // Subtraction is NaN when both scores are non-finite; compare so ties stay put.
  scored.sort((a, b) => (a.score === b.score ? 0 : a.score < b.score ? 1 : -1));
  const secondary = scored[0]?.shape ?? "oval";

  const confidence = Math.max(0, Math.min(1, margins[winner.shape] ?? 0));
  return { primary: winner.shape, secondary, confidence, margins };
}
