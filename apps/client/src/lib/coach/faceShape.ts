/**
 * Face-shape classification: the section 4 cascade, first match wins.
 *
 * Spec: docs/FACE-GEOMETRY.md section 4. Pure function over the
 * measurements from coach/measure.ts; thresholds live in thresholds.json
 * (placeholder values until WFLW calibration) so retuning never touches
 * code. Every rule records its margin: the runner-up rule becomes the
 * secondary shape and confidence is the normalized margin. A face that
 * matches nothing (or arrives yaw-gated) defaults to "balanced/oval" with
 * low confidence - never a wrong strong claim, never an error.
 */

import thresholdsJson from "./thresholds.json" with { type: "json" };
import type { FaceMeasurements } from "./measure.ts";

export const FACE_SHAPES = ["long", "round", "square", "heart", "triangle", "diamond", "oval"] as const;
export type FaceShape = (typeof FACE_SHAPES)[number];

/** JSON shape of thresholds.json (kept narrow on purpose). */
export interface Thresholds {
  version: number;
  calibration: string;
  FLPR: { longMin: number; roundMax: number; squareMax: number };
  jawAng: { roundMinDeg: number; squareMaxDeg: number };
  JBR: { squareMin: number };
  FBR: { heartMin: number };
  triangle: { jawOverForehead: number };
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

/**
 * The ordered cascade. Each margin is expressed in the rule's own units
 * (ratios or degrees) so the JSON thresholds stay the single knob set.
 * First non-negative margin wins (spec boundaries are inclusive: >=, <=).
 */
const CASCADE: Rule[] = [
  { shape: "long", margin: (m) => m.FLPR - thresholds.FLPR.longMin },
  {
    shape: "round",
    margin: (m) => Math.min(thresholds.FLPR.roundMax - m.FLPR, m.jawAng - thresholds.jawAng.roundMinDeg),
  },
  {
    shape: "square",
    margin: (m) =>
      Math.min(thresholds.FLPR.squareMax - m.FLPR, thresholds.jawAng.squareMaxDeg - m.jawAng, m.JBR - thresholds.JBR.squareMin),
  },
  { shape: "heart", margin: (m) => m.FBR - thresholds.FBR.heartMin },
  { shape: "triangle", margin: (m) => m.JW - m.FW * thresholds.triangle.jawOverForehead },
  {
    shape: "diamond",
    margin: (m) =>
      Math.min(
        m.CW - m.FW * thresholds.diamond.cheekOverForehead,
        m.CW - m.JW * thresholds.diamond.cheekOverJaw,
        thresholds.diamond.chinPointedMaxDeg - m.chinAng,
      ),
  },
];

/**
 * Classify. Null measurements (yaw-gated or degenerate) classify as
 * balanced/oval with zero confidence - the explicit "balanced" default,
 * never an error, per the bias guardrails (section 9).
 */
export function classifyFace(m: FaceMeasurements | null): Classification {
  if (!m) {
    return { primary: "oval", secondary: "oval", confidence: 0, margins: {} };
  }

  const margins: Partial<Record<FaceShape, number>> = {};
  for (const rule of CASCADE) margins[rule.shape] = rule.margin(m);

  const winner = CASCADE.find((r) => (margins[r.shape] ?? -Infinity) >= 0);
  if (!winner) {
    // 1.15 < FLPR < 1.60 with balanced widths: the oval band (rule 7).
    return { primary: "oval", secondary: "oval", confidence: 0.5, margins };
  }

  // Runner-up: the best-scoring non-winner. Margins live in mixed units
  // (ratios vs degrees); normalize by the rule's operating scale so the
  // comparison is fair. Degree rules get divided by 10, ratio rules by 0.1.
  const scale = (r: Rule): number => (r.shape === "round" || r.shape === "square" ? 10 : 0.1);
  const scored = CASCADE.filter((r) => r !== winner).map((r) => ({
    shape: r.shape,
    score: (margins[r.shape] ?? -Infinity) / scale(r),
  }));
  scored.sort((a, b) => b.score - a.score);
  const secondary = scored[0]?.shape ?? "oval";

  const winnerScale = scale(winner);
  const confidence = Math.max(0, Math.min(1, (margins[winner.shape] ?? 0) / winnerScale));
  return { primary: winner.shape, secondary, confidence, margins };
}
