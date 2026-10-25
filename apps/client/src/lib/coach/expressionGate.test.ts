/**
 * Unit tests for the expression gates (lib/coach/expressionGate.ts).
 *
 * Covers: the inner-lip aspect ratio on closed / half / wide synthetic
 * meshes (and its scale/roll invariance), the blendshape parser policy,
 * the fade curve shape, per-zone sensitivities, and the fail-open
 * contract (absent or broken signals keep full pigment).
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GATED_ZONES,
  LIP_CORNER_L,
  LIP_CORNER_R,
  LIP_LOWER_CENTER,
  LIP_UPPER_CENTER,
  blendScoresFromCategories,
  expressionGain,
  expressionSignals,
  fadeGain,
  gateSpec,
  lipOpenness,
} from "./expressionGate.ts";

/**
 * Synthetic mesh with only the four lip landmarks placed: corners at
 * +/-halfW/2 around (0.5, 0.7), inner centers separated by gap (vertical).
 * `gap` is the raw center-to-center distance, so openness = gap / halfW.
 */
function lipMesh(halfW: number, gap: number): { x: number; y: number }[] {
  const pts = new Array(478).fill(undefined).map((_, i) => ({ x: i / 1000, y: 0.5 }));
  pts[LIP_CORNER_L] = { x: 0.5 - halfW / 2, y: 0.7 };
  pts[LIP_CORNER_R] = { x: 0.5 + halfW / 2, y: 0.7 };
  pts[LIP_UPPER_CENTER] = { x: 0.5, y: 0.7 - gap / 2 };
  pts[LIP_LOWER_CENTER] = { x: 0.5, y: 0.7 + gap / 2 };
  return pts;
}

test("lipOpenness reads the inner-lip aspect ratio on closed / half / wide meshes", () => {
  const W = 0.1;
  // Closed: centers coincide -> ratio 0.
  assert.equal(lipOpenness(lipMesh(W, 0)), 0);
  // Half-open: gap 0.03 over width 0.1.
  assert.ok(Math.abs((lipOpenness(lipMesh(W, 0.03)) ?? -1) - 0.3) < 1e-12);
  // Wide: gap 0.06 over width 0.1.
  assert.ok(Math.abs((lipOpenness(lipMesh(W, 0.06)) ?? -1) - 0.6) < 1e-12);
});

test("lipOpenness is scale- and roll-invariant (corner width is the normalizer)", () => {
  const base = lipOpenness(lipMesh(0.1, 0.04));
  assert.ok(base !== null);
  // Scale everything 2x, rotate 30 degrees: the ratio must not move.
  const a = (30 * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  const rot = lipMesh(0.2, 0.08).map((p, i) =>
    [LIP_UPPER_CENTER, LIP_LOWER_CENTER, LIP_CORNER_L, LIP_CORNER_R].includes(i)
      ? { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos }
      : p,
  );
  assert.ok(Math.abs((lipOpenness(rot) ?? -1) - base) < 1e-9);
});

test("lipOpenness fails null on missing / non-finite / degenerate input", () => {
  assert.equal(lipOpenness(null), null);
  assert.equal(lipOpenness([]), null);
  assert.equal(lipOpenness(lipMesh(0, 0.02)), null, "corners coincide: no width, no ratio");
  const nanMesh = lipMesh(0.1, 0.02);
  nanMesh[LIP_UPPER_CENTER] = { x: Number.NaN, y: 0.7 };
  assert.equal(lipOpenness(nanMesh), null);
});

test("blendshape parser: jawOpen direct, smile = mean of Left and Right", () => {
  const cats = [
    { categoryName: "browDownLeft", score: 0.1 },
    { categoryName: "jawOpen", score: 0.62 },
    { categoryName: "mouthSmileLeft", score: 0.7 },
    { categoryName: "mouthSmileRight", score: 0.3 },
  ];
  assert.deepEqual(blendScoresFromCategories(cats), { jawOpen: 0.62, mouthSmile: 0.5 });
  // Either smile alone still carries.
  assert.deepEqual(
    blendScoresFromCategories([{ categoryName: "mouthSmileLeft", score: 0.4 }]),
    { jawOpen: null, mouthSmile: 0.4 },
  );
  // Missing list, no lip categories, or broken scores read null.
  assert.deepEqual(blendScoresFromCategories(null), { jawOpen: null, mouthSmile: null });
  assert.deepEqual(blendScoresFromCategories([{ categoryName: "eyeBlinkLeft", score: 0.9 }]),
    { jawOpen: null, mouthSmile: null });
  assert.deepEqual(blendScoresFromCategories([{ categoryName: "jawOpen", score: Number.NaN }]),
    { jawOpen: null, mouthSmile: null });
  // Scores above 1 clamp, not NaN.
  assert.equal(blendScoresFromCategories([{ categoryName: "jawOpen", score: 1.4 }]).jawOpen, 1);
});

test("fadeGain: 1 below lo, 0 above hi, smooth and monotone between, fail-open", () => {
  assert.equal(fadeGain(null, 0.2, 0.5), 1, "absent signal keeps pigment");
  assert.equal(fadeGain(Number.NaN, 0.2, 0.5), 1);
  assert.equal(fadeGain(0.1, 0.2, 0.5), 1);
  assert.equal(fadeGain(0.2, 0.2, 0.5), 1, "at the low knee");
  assert.equal(fadeGain(0.5, 0.2, 0.5), 0, "at the high knee");
  assert.equal(fadeGain(0.9, 0.2, 0.5), 0);
  const mid = fadeGain(0.35, 0.2, 0.5);
  assert.ok(mid > 0 && mid < 1, "midpoint fades, not a cliff");
  assert.ok(Math.abs(mid - 0.5) < 1e-12, "smoothstep midpoint is 0.5");
  let prev = 1;
  for (let x = 0.21; x < 0.5; x += 0.01) {
    const g = fadeGain(x, 0.2, 0.5);
    assert.ok(g <= prev, "monotone down");
    prev = g;
  }
});

test("closed, neutral face keeps full pigment on every gated zone", () => {
  const closed = expressionSignals({ lipOpenness: 0.02, jawOpen: 0.03, mouthSmile: 0.08 });
  for (const zone of [...GATED_ZONES.lip, ...GATED_ZONES.mouth, ...GATED_ZONES.cheek]) {
    assert.equal(expressionGain(zone, closed), 1, zone);
  }
});

test("wide-open mouth fades lip first, then mouth zones; cheeks hold", () => {
  const open = expressionSignals({ lipOpenness: 0.7, jawOpen: 0.75, mouthSmile: 0.05 });
  assert.equal(expressionGain("cupid_bow", open), 0, "lip zone fully faded");
  assert.equal(expressionGain("chin_ball", open), 0, "mouth zone fully faded");
  const cheek = expressionGain("cheek_apple_L", open);
  assert.ok(cheek > 0 && cheek < 1, "cheek fades only on the jawOpen band");
  // Neutral cheeks: an open mouth alone does not fade the apples.
  const openNoJaw = expressionSignals({ lipOpenness: 0.6, jawOpen: 0.05, mouthSmile: 0.08 });
  assert.equal(expressionGain("cheek_apple_L", openNoJaw), 1, "cheek has no lipOpen entry");
});

test("big smile fades cheeks and lips; a polite smile keeps pigment", () => {
  const beaming = expressionSignals({ lipOpenness: 0.05, jawOpen: 0.08, mouthSmile: 0.85 });
  assert.equal(expressionGain("cheek_apple_L", beaming), 0);
  assert.equal(expressionGain("cheek_tip_R", beaming), 0);
  assert.equal(expressionGain("cupid_bow", beaming), 0);
  const polite = expressionSignals({ lipOpenness: 0.05, jawOpen: 0.08, mouthSmile: 0.3 });
  for (const zone of [...GATED_ZONES.lip, ...GATED_ZONES.mouth, ...GATED_ZONES.cheek]) {
    assert.equal(expressionGain(zone, polite), 1, zone);
  }
});

test("partial signals multiply: two half-fades land below either alone", () => {
  // cupid_bow bands: lipOpen [0.2, 0.45] -> 0.3 gives ~0.65; jawOpen
  // [0.3, 0.55] -> 0.425 gives 0.5. The product must be below both.
  const s = expressionSignals({ lipOpenness: 0.3, jawOpen: 0.425, mouthSmile: 0.05 });
  const g = expressionGain("cupid_bow", s);
  assert.ok(g > 0 && g < 0.5, `gain ${g} should sit below each single-signal fade`);
});

test("ungated zones and unknown ids keep gain 1 no matter the expression", () => {
  const wild = expressionSignals({ lipOpenness: 0.9, jawOpen: 0.95, mouthSmile: 0.95 });
  for (const zone of ["nose_bridge", "under_eye_L", "forehead_center", "temple_L", "hairline_top", "some_future_zone"]) {
    assert.equal(expressionGain(zone, wild), 1, zone);
  }
  assert.equal(gateSpec("nose_bridge"), null);
  assert.ok(gateSpec("cheek_shelf_L") !== null, "corner ribbons are gated");
});

test("fail-open: absent or broken signals paint the closed-mouth default", () => {
  const none = expressionSignals({});
  for (const zone of [...GATED_ZONES.lip, ...GATED_ZONES.mouth, ...GATED_ZONES.cheek]) {
    assert.equal(expressionGain(zone, none), 1, zone);
  }
  // Raw NaN inputs map to null (never NaN gains).
  const messy = expressionSignals({ lipOpenness: Number.NaN, jawOpen: "x", mouthSmile: undefined });
  assert.deepEqual(messy, { lipOpenness: null, jawOpen: null, mouthSmile: null });
  assert.equal(expressionGain("cupid_bow", messy), 1);
  // jawOpen from a stale landmarker without blendshapes: lip-part alone still gates.
  const lipOnly = expressionSignals({ lipOpenness: 0.7, jawOpen: null, mouthSmile: null });
  assert.equal(expressionGain("cupid_bow", lipOnly), 0);
  assert.equal(expressionGain("chin_ball", lipOnly), 0);
});
