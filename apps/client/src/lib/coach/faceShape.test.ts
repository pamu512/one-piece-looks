/**
 * Tests for coach/faceShape.ts - the section 4 cascade on synthetic
 * measurement vectors, boundary cases at each threshold.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyFace, thresholds, type Classification } from "./faceShape.ts";
import type { FaceMeasurements } from "./measure.ts";

/** Balanced mid-band vector: classifies oval via the fall-through rule 7. */
const OVAL: FaceMeasurements = {
  FL: 1.3, CW: 0.98, JW: 0.85, FW: 0.95, MW: 0.45,
  FLPR: 1.3, JBR: 0.85, FBR: 0.92, jawAng: 148, chinAng: 120,
};

function with_(over: Partial<FaceMeasurements>): FaceMeasurements {
  return { ...OVAL, ...over };
}

function shapeOf(m: FaceMeasurements): Classification {
  return classifyFace(m);
}

test("each cascade rule fires at its boundary, first match wins", () => {
  // 1. long: FLPR >= longMin
  assert.equal(shapeOf(with_({ FLPR: thresholds.FLPR.longMin })).primary, "long");
  // 2. round: FLPR <= roundMax AND jawAng >= roundMinDeg
  assert.equal(shapeOf(with_({ FLPR: thresholds.FLPR.roundMax, jawAng: thresholds.jawAng.roundMinDeg })).primary, "round");
  // 3. square: FLPR <= squareMax AND jawAng <= squareMaxDeg AND JBR >= squareMin
  assert.equal(
    shapeOf(with_({ FLPR: thresholds.FLPR.squareMax, jawAng: thresholds.jawAng.squareMaxDeg, JBR: thresholds.JBR.squareMin })).primary,
    "square",
  );
  // 4. heart: FBR >= heartMin
  assert.equal(shapeOf(with_({ FBR: thresholds.FBR.heartMin })).primary, "heart");
  // 5. triangle: JW > FW * jawOverForehead
  const fw = 0.9;
  assert.equal(shapeOf(with_({ FW: fw, JW: fw * thresholds.triangle.jawOverForehead + 0.01 })).primary, "triangle");
  // 6. diamond: CW > FW*cheekOverForehead AND CW > JW*cheekOverJaw AND pointed chin
  const jw = 0.8, cw = 1.0;
  assert.equal(
    shapeOf(with_({ CW: cw, JW: jw, FW: cw / thresholds.diamond.cheekOverForehead - 0.01, chinAng: thresholds.diamond.chinPointedMaxDeg })).primary,
    "diamond",
  );
});

test("boundary-epsilon: just under a threshold falls through to the next rule", () => {
  // just under longMin, everything else balanced -> not long
  const c = shapeOf(with_({ FLPR: thresholds.FLPR.longMin - 0.02 }));
  assert.notEqual(c.primary, "long");
  // heart requires FBR >= heartMin; a hair under falls through
  const h = shapeOf(with_({ FBR: thresholds.FBR.heartMin - 0.005 }));
  assert.notEqual(h.primary, "heart");
});

test("balanced band classifies oval with mid confidence", () => {
  const c = shapeOf(OVAL);
  assert.equal(c.primary, "oval");
  assert.equal(c.secondary, "oval");
  assert.ok(c.confidence > 0 && c.confidence <= 1);
});

test("null measurements classify balanced/oval with zero confidence (never an error)", () => {
  const c = classifyFace(null);
  assert.equal(c.primary, "oval");
  assert.equal(c.confidence, 0);
});

test("margins are recorded for every cascade rule", () => {
  const c = shapeOf(with_({ FLPR: 1.7 }));
  assert.equal(c.primary, "long");
  for (const shape of ["long", "round", "square", "heart", "triangle", "diamond"] as const) {
    assert.ok(typeof c.margins[shape] === "number", `margin recorded for ${shape}`);
  }
});

test("runner-up becomes secondary and confidence is normalized 0..1", () => {
  const deep = shapeOf(with_({ FLPR: thresholds.FLPR.longMin + 0.3 }));
  assert.equal(deep.primary, "long");
  assert.ok(deep.confidence > 0.5, `deep margin -> higher confidence (${deep.confidence.toFixed(2)})`);
  assert.ok(deep.secondary !== "long", "secondary is the runner-up, not the winner");
  const edge = shapeOf(with_({ FLPR: thresholds.FLPR.longMin + 0.001 }));
  assert.ok(edge.confidence < 0.1, `barely-in -> low confidence (${edge.confidence.toFixed(3)})`);
});

test("classification is deterministic", () => {
  const m = with_({ JBR: 0.9, jawAng: 158 });
  const a = JSON.stringify(shapeOf(m));
  const b = JSON.stringify(shapeOf({ ...m }));
  assert.equal(a, b);
});
