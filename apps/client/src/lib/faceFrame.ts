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
 * train / 2500 test faces; regenerate with scratch/train/wflw_bands.py).
 * The constants below are the test-split p5/p95 values, widened slightly
 * toward box-interior margins to tolerate box jitter.
 */

import type { FaceBox } from "./face";

/*
 * Band literals below are DERIVED from apps/client/src/lib/face-bands.json
 * (WFLW test split, 2500 faces). faceFrame.test.ts asserts the literals
 * still equal the JSON, so regenerating the JSON without updating these
 * constants fails the test instead of shipping drift.
 */
const TEST_MOUTH_P5 = 0.6261, TEST_MOUTH_P95 = 0.849;
const TEST_EYE_P5 = 0.2506, TEST_EYE_P95 = 0.494;
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

/** Eye band inside any faceBox: WFLW eye_y p5..p95, margin-widened. */
export const EYE_BAND = {
  y0: Math.floor((TEST_EYE_P5 - 0.03) * 100) / 100, // 0.22
  y1: Math.ceil((TEST_EYE_P95 + 0.03) * 100) / 100, // 0.52
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
