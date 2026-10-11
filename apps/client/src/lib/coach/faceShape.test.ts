/**
 * Tests for coach/faceShape.ts - the nine-label cascade on synthetic
 * measurement vectors, boundary cases at each threshold.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyFace, FACE_SHAPES, thresholds, type Classification } from "./faceShape.ts";
import type { FaceMeasurements } from "./measure.ts";

/** Balanced mid-band vector: classifies oval via the fall-through. */
const OVAL: FaceMeasurements = {
  FL: 1.3, CW: 0.98, JW: 0.85, FW: 0.95, MW: 0.45,
  FLPR: 1.3, JBR: 0.85, FBR: 0.92, HWR: 0.97, jawAng: 148, chinAng: 120,
};

function with_(over: Partial<FaceMeasurements>): FaceMeasurements {
  return { ...OVAL, ...over };
}

function shapeOf(m: FaceMeasurements): Classification {
  return classifyFace(m);
}

const RECTANGLE: Partial<FaceMeasurements> = {
  FLPR: thresholds.FLPR.oblongMin,
  jawAng: thresholds.jawAng.squareMaxDeg,
  JBR: thresholds.JBR.squareMin,
  HWR: (thresholds.HWR.rectangleMin + thresholds.HWR.rectangleMax) / 2,
};

test("emits the nine chart labels", () => {
  assert.deepEqual([...FACE_SHAPES], [
    "oval", "round", "square", "pear", "heart", "diamond", "oblong", "rectangle", "invTriangle",
  ]);
});

test("threshold bands stay ordered so the hairline branch can split", () => {
  assert.ok(thresholds.FLPR.roundMax < thresholds.FLPR.squareMax);
  assert.ok(thresholds.FLPR.squareMax < thresholds.FLPR.oblongMin);
  assert.ok(thresholds.HWR.rectangleMin < thresholds.HWR.invTriangleMin);
  assert.ok(thresholds.HWR.invTriangleMin <= thresholds.HWR.rectangleMax);
  assert.ok(thresholds.HWR.rectangleMax > thresholds.HWR.rectangleMin);
});

test("each cascade rule fires at its boundary, first match wins", () => {
  // rectangle: long + square jaw + hairline near the cheek width, inclusive HWR edges
  assert.equal(shapeOf(with_(RECTANGLE)).primary, "rectangle");
  assert.equal(shapeOf(with_({ ...RECTANGLE, HWR: thresholds.HWR.rectangleMin })).primary, "rectangle");
  assert.equal(shapeOf(with_({ ...RECTANGLE, HWR: thresholds.HWR.rectangleMax })).primary, "rectangle");
  // oblong: the old long rule, once rectangle does not match
  assert.equal(shapeOf(with_({ FLPR: thresholds.FLPR.oblongMin })).primary, "oblong");
  // round: FLPR <= roundMax AND jawAng >= roundMinDeg
  assert.equal(shapeOf(with_({ FLPR: thresholds.FLPR.roundMax, jawAng: thresholds.jawAng.roundMinDeg })).primary, "round");
  // square: FLPR <= squareMax AND jawAng <= squareMaxDeg AND JBR >= squareMin
  assert.equal(
    shapeOf(with_({ FLPR: thresholds.FLPR.squareMax, jawAng: thresholds.jawAng.squareMaxDeg, JBR: thresholds.JBR.squareMin })).primary,
    "square",
  );
  // invTriangle: HWR >= invTriangleMin AND FBR >= heartMin; heart is the runner-up
  const inv = shapeOf(with_({ HWR: thresholds.HWR.invTriangleMin, FBR: thresholds.FBR.heartMin }));
  assert.equal(inv.primary, "invTriangle");
  assert.equal(inv.secondary, "heart");
  // heart: FBR >= heartMin, hairline not wider than the cheeks
  assert.equal(shapeOf(with_({ FBR: thresholds.FBR.heartMin })).primary, "heart");
  // pear: triangle mapped here. JW >= FW * jawOverForehead, inclusive
  const fw = 0.9;
  const jawCut = fw * thresholds.pear.jawOverForehead;
  assert.equal(shapeOf(with_({ FW: fw, JW: jawCut })).primary, "pear");
  assert.equal(shapeOf(with_({ FW: fw, JW: jawCut + 0.01 })).primary, "pear");
  assert.notEqual(shapeOf(with_({ FW: fw, JW: jawCut - 0.001 })).primary, "pear");
  // diamond: CW > FW*cheekOverForehead AND CW > JW*cheekOverJaw AND pointed chin
  const jw = 0.8, cw = 1.0;
  assert.equal(
    shapeOf(with_({
      CW: cw,
      JW: jw,
      FW: cw / thresholds.diamond.cheekOverForehead - 0.01,
      chinAng: thresholds.diamond.chinPointedMaxDeg,
    })).primary,
    "diamond",
  );
});

test("boundary-epsilon: just outside a threshold falls through to the next rule", () => {
  const underLong = shapeOf(with_({ FLPR: thresholds.FLPR.oblongMin - 0.02 }));
  assert.notEqual(underLong.primary, "oblong");
  assert.notEqual(underLong.primary, "rectangle");

  const heart = shapeOf(with_({ FBR: thresholds.FBR.heartMin - 0.005 }));
  assert.notEqual(heart.primary, "heart");
  assert.notEqual(heart.primary, "invTriangle");

  // hairline a hair under the cut, jaw still narrow -> heart, not invTriangle
  assert.equal(
    shapeOf(with_({ FBR: thresholds.FBR.heartMin, HWR: thresholds.HWR.invTriangleMin - 0.01 })).primary,
    "heart",
  );
  // hairline past the rectangle band on an otherwise rectangular face -> oblong
  assert.equal(
    shapeOf(with_({ ...RECTANGLE, HWR: thresholds.HWR.rectangleMax + 0.02 })).primary,
    "oblong",
  );
  assert.equal(
    shapeOf(with_({ ...RECTANGLE, HWR: thresholds.HWR.rectangleMin - 0.02 })).primary,
    "oblong",
  );
});

test("hairline branch: a long face with a wide hairline and a narrow jaw is invTriangle", () => {
  const c = shapeOf(with_({
    FLPR: thresholds.FLPR.oblongMin + 0.2,
    FBR: thresholds.FBR.heartMin,
    HWR: thresholds.HWR.invTriangleMin,
  }));
  assert.equal(c.primary, "invTriangle");
  assert.ok((c.margins.oblong ?? 0) < 0, "oblong yields the long wide-hairline face");
});

test("round and square still win when they also satisfy the hairline branch", () => {
  assert.equal(
    shapeOf(with_({
      FLPR: thresholds.FLPR.roundMax,
      jawAng: thresholds.jawAng.roundMinDeg,
      HWR: thresholds.HWR.invTriangleMin,
      FBR: thresholds.FBR.heartMin,
    })).primary,
    "round",
  );
  assert.equal(
    shapeOf(with_({
      FLPR: thresholds.FLPR.squareMax,
      jawAng: thresholds.jawAng.squareMaxDeg,
      JBR: thresholds.JBR.squareMin,
      HWR: 1.1,
      FBR: 1.1 / thresholds.JBR.squareMin,
    })).primary,
    "square",
  );
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
  assert.equal(c.primary, "oblong");
  for (const shape of ["rectangle", "oblong", "round", "square", "invTriangle", "heart", "pear", "diamond"] as const) {
    assert.equal(typeof c.margins[shape], "number", `margin recorded for ${shape}`);
    assert.ok(Number.isFinite(c.margins[shape]), `${shape} margin is finite`);
  }
});

test("runner-up becomes secondary and confidence is normalized 0..1", () => {
  const deep = shapeOf(with_({ FLPR: thresholds.FLPR.oblongMin + 0.3 }));
  assert.equal(deep.primary, "oblong");
  assert.ok(deep.confidence > 0.5, `deep margin -> higher confidence (${deep.confidence.toFixed(2)})`);
  assert.ok(deep.secondary !== "oblong", "secondary is the runner-up, not the winner");
  const edge = shapeOf(with_({ FLPR: thresholds.FLPR.oblongMin + 0.001 }));
  assert.ok(edge.confidence < 0.1, `barely-in -> low confidence (${edge.confidence.toFixed(3)})`);

  const rect = shapeOf(with_(RECTANGLE));
  assert.equal(rect.primary, "rectangle");
  assert.equal(rect.secondary, "oblong");
  assert.equal(rect.confidence, 0, "on the rectangle boundary the tightest slack is zero");
});

test("a face inside the rectangle box keeps a real confidence", () => {
  const deep = shapeOf(with_({
    FLPR: thresholds.FLPR.oblongMin + 0.3,
    jawAng: thresholds.jawAng.squareMaxDeg - 20,
    JBR: thresholds.JBR.squareMin + 0.06,
    HWR: (thresholds.HWR.rectangleMin + thresholds.HWR.rectangleMax) / 2,
  }));
  assert.equal(deep.primary, "rectangle");
  assert.ok(deep.confidence > 0.5, `deep rectangle confidence ${deep.confidence}`);
  assert.ok(deep.confidence <= 1);
});

test("non-finite HWR falls back to FW/CW and does not throw", () => {
  const fromWidths = shapeOf(with_({
    HWR: Number.NaN,
    FW: 1.1,
    CW: 1,
    FBR: thresholds.FBR.heartMin,
    FLPR: 1.3,
  }));
  assert.equal(fromWidths.primary, "invTriangle");

  const rectFromWidths = shapeOf(with_({
    ...RECTANGLE,
    HWR: Number.NaN,
    FW: 1,
    CW: 1,
  }));
  assert.equal(rectFromWidths.primary, "rectangle");

  const longUnread = shapeOf(with_({
    FLPR: thresholds.FLPR.oblongMin,
    HWR: Number.NaN,
    FW: Number.NaN,
    CW: 0,
  }));
  assert.equal(longUnread.primary, "oblong");

  const junkM: FaceMeasurements = {
    FL: Number.NaN, CW: 0, JW: Number.NaN, FW: Number.NaN, MW: Number.NaN,
    FLPR: Number.NaN, JBR: Number.NaN, FBR: Number.NaN, HWR: Number.NaN,
    jawAng: Number.NaN, chinAng: Number.NaN,
  };
  const junk = shapeOf(junkM);
  assert.equal(junk.primary, "oval");
  assert.equal(junk.confidence, 0);
  const noLength = shapeOf(with_({ FLPR: Number.NaN }));
  assert.equal(noLength.primary, "oval");
  assert.equal(noLength.confidence, 0);
  assert.equal(JSON.stringify(junk), JSON.stringify(shapeOf(junkM)));
  for (const shape of ["rectangle", "oblong", "round", "square", "invTriangle", "heart", "pear", "diamond"] as const) {
    assert.equal(Number.isNaN(junk.margins[shape]), false, `${shape} margin is not NaN on junk input`);
  }
});

test("classification is deterministic", () => {
  const m = with_({ JBR: 0.9, jawAng: 158 });
  const a = JSON.stringify(shapeOf(m));
  const b = JSON.stringify(shapeOf({ ...m }));
  assert.equal(a, b);
});
