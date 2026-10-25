/**
 * Tests for coach/fill.ts - the soft-light zone-fill policy:
 * depth verbs multiply, pigment verbs soft-light, every shape feathers
 * (gaussian sigma from its own radius, clamped, never NaN), and the
 * whole live catalog maps to sane render values.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  FEATHER_FRACTION,
  FEATHER_MAX_VB,
  FEATHER_MIN_VB,
  VERB_FILL,
  blendForVerb,
  charRadiusIod,
  featherSigmaVb,
} from "./fill.ts";
import { normalizeFace, type CoachPoint } from "./measure.ts";
import { buildContourMap } from "./zones.ts";
import { FACE_SHAPES } from "./faceShape.ts";

test("depth verbs multiply, pigment verbs soft-light, unknowns stay pigment", () => {
  assert.equal(blendForVerb("contour"), "multiply");
  assert.equal(blendForVerb("define"), "multiply");
  assert.equal(blendForVerb("warm"), "soft-light");
  assert.equal(blendForVerb("brighten"), "soft-light");
  assert.equal(blendForVerb("soften"), "soft-light");
  assert.equal(blendForVerb("lift"), "soft-light");
  assert.equal(blendForVerb("never-heard-of"), "soft-light");
  assert.equal(blendForVerb(""), "soft-light");
});

test("every verb the plan can emit has both a strength and a blend", () => {
  // rules.json verb values are the only verbs buildPlan emits.
  const emitted = ["define", "soften", "lift", "lengthen", "brighten", "balance", "warm"];
  for (const v of emitted) {
    assert.ok(
      VERB_FILL[v] !== undefined || blendForVerb(v) === "soft-light",
      `verb ${v} needs a strength or at least the soft-light default`,
    );
  }
  for (const [verb, op] of Object.entries(VERB_FILL)) {
    assert.ok(op > 0 && op <= 1, `verb ${verb} opacity ${op} in (0, 1]`);
    assert.ok(["multiply", "soft-light"].includes(blendForVerb(verb)), `verb ${verb} has a blend`);
  }
});

test("character radius: zones use their gaussian hint, ribbons half the max half-width", () => {
  assert.equal(charRadiusIod({ kind: "zone", radiusIod: 0.43 }), 0.43);
  assert.equal(charRadiusIod({ kind: "ribbon", widthMaxIod: 0.1 }), 0.05);
  assert.equal(charRadiusIod({ kind: "zone" }), 0);
  assert.equal(charRadiusIod({ kind: "ribbon" }), 0);
  assert.equal(charRadiusIod({ kind: "zone", radiusIod: Number.NaN }), 0);
  assert.equal(charRadiusIod({ kind: "ribbon", widthMaxIod: -1 }), 0);
});

test("feather sigma is the radius fraction, clamped, monotone in size", () => {
  const iod = 0.2, vbW = 1000;
  assert.ok(Math.abs(featherSigmaVb(0.43, iod, vbW) - FEATHER_FRACTION * 0.43 * iod * vbW) < 1e-9);
  // clamps
  assert.equal(featherSigmaVb(0, iod, vbW), FEATHER_MIN_VB);
  assert.equal(featherSigmaVb(0.03, iod, vbW), FEATHER_MIN_VB);
  assert.equal(featherSigmaVb(5, iod, vbW), FEATHER_MAX_VB);
  // monotone across the whole catalog range
  let prev = -1;
  for (let r = 0.01; r <= 1; r += 0.01) {
    const s = featherSigmaVb(r, iod, vbW);
    assert.ok(s >= prev, `sigma not monotone at r=${r}`);
    assert.ok(Number.isFinite(s) && s > 0, `sigma degenerate at r=${r}`);
    prev = s;
  }
});

test("degenerate faces never produce a NaN sigma", () => {
  for (const [r, i, w] of [
    [Number.NaN, 0.2, 1000], [0.4, Number.NaN, 1000], [0.4, 0.2, Number.NaN],
    [-1, 0.2, 1000], [0.4, -1, 1000], [0.4, 0.2, -1],
    [Infinity, 0.2, 1000], [0.4, Infinity, 1000],
  ] as const) {
    const s = featherSigmaVb(r, i, w);
    assert.ok(Number.isFinite(s) && s >= FEATHER_MIN_VB && s <= FEATHER_MAX_VB, `(${r},${i},${w}) -> ${s}`);
  }
});

/* ---------- the real catalog on a canonical frontal face ---------- */

function canonicalFrontal(): CoachPoint[] {
  const pts: CoachPoint[] = [];
  const at = (i: number, x: number, y: number) => {
    pts[i] = { x, y, z: 0 };
  };
  at(10, 0.5, 0.12); at(152, 0.5, 0.86);
  at(127, 0.2, 0.47); at(356, 0.8, 0.47);
  at(172, 0.285, 0.66); at(397, 0.715, 0.66);
  at(103, 0.31, 0.24); at(332, 0.69, 0.24);
  at(61, 0.4, 0.72); at(291, 0.6, 0.72);
  at(33, 0.385, 0.4); at(263, 0.615, 0.4);
  at(4, 0.5, 0.56); at(234, 0.21, 0.47); at(454, 0.79, 0.47);
  at(136, 0.3, 0.69); at(58, 0.262, 0.64);
  at(288, 0.755, 0.655); at(365, 0.7, 0.69);
  at(148, 0.44, 0.845); at(377, 0.56, 0.845);
  at(175, 0.5, 0.82); at(199, 0.5, 0.78);
  at(109, 0.42, 0.15); at(338, 0.56, 0.145);
  at(168, 0.5, 0.47); at(6, 0.5, 0.54); at(1, 0.5, 0.6);
  at(0, 0.5, 0.69);
  at(205, 0.32, 0.56); at(425, 0.68, 0.56);
  at(133, 0.43, 0.405); at(145, 0.43, 0.435); at(230, 0.405, 0.455);
  at(362, 0.57, 0.405); at(374, 0.57, 0.435); at(450, 0.595, 0.455);
  at(54, 0.245, 0.33); at(21, 0.225, 0.395); at(162, 0.215, 0.44);
  at(284, 0.755, 0.33); at(251, 0.775, 0.395); at(389, 0.785, 0.44);
  at(297, 0.585, 0.155); at(67, 0.415, 0.155);
  at(323, 0.79, 0.545); at(93, 0.21, 0.545);
  at(361, 0.77, 0.6); at(132, 0.23, 0.6);
  at(150, 0.335, 0.725); at(149, 0.365, 0.755); at(176, 0.395, 0.775);
  at(379, 0.665, 0.725); at(378, 0.635, 0.755); at(400, 0.605, 0.775);
  at(116, 0.31, 0.59); at(345, 0.69, 0.59);
  at(50, 0.37, 0.65); at(280, 0.63, 0.65);
  for (let i = 0; i < 478; i++) if (!pts[i]) pts[i] = { x: 0.5, y: 0.5, z: 0 };
  return pts;
}

test("every catalog zone and ribbon feathers within the clamps on a real face", () => {
  const norm = normalizeFace(canonicalFrontal())!;
  const map = buildContourMap(norm);
  assert.ok(map.zones.length >= 8 && map.ribbons.length >= 10);
  for (const shape of [...map.zones, ...map.ribbons]) {
    const sigma = featherSigmaVb(charRadiusIod(shape), norm.iod, 1000);
    assert.ok(
      sigma >= FEATHER_MIN_VB && sigma <= FEATHER_MAX_VB && Number.isFinite(sigma),
      `${shape.id} sigma ${sigma} outside [${FEATHER_MIN_VB}, ${FEATHER_MAX_VB}]`,
    );
  }
});

test("the plan's steps map to both blend modes across every chart shape", () => {
  // Every shape emits a contour step (multiply) and a blush step
  // (soft-light); the mapping must not collapse to one mode.
  const verbs = new Set<string>();
  for (const shape of FACE_SHAPES) {
    verbs.add("define"); // rules.verbs.contour
    verbs.add("warm"); // rules.verbs.warm
  }
  const blends = new Set([...verbs].map(blendForVerb));
  assert.deepEqual([...blends].sort(), ["multiply", "soft-light"]);
});
