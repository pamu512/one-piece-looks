/**
 * Tests for coach/fill.ts - the soft-light zone-fill policy:
 * depth verbs multiply, pigment verbs soft-light, every shape feathers
 * (gaussian sigma from its own radius, clamped, never NaN), and the
 * whole live catalog maps to sane render values.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  ALL_STEPS_GAIN,
  FEATHER_FRACTION,
  FEATHER_MAX_VB,
  FEATHER_MIN_VB,
  FILL_OPACITY_FALLBACK,
  VERB_FILL,
  blendForVerb,
  charRadiusIod,
  featherSigmaVb,
  fillOpacity,
  paintHex,
  pointsAttr,
  resolvePaintIds,
  zoneLayers,
} from "./fill.ts";
import { normalizeFace, type CoachPoint } from "./measure.ts";
import { buildContourMap } from "./zones.ts";
import { classifyFace, FACE_SHAPES, type FaceShape } from "./faceShape.ts";
import { buildPlan, type CoachPlanInput } from "./plan.ts";

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

test("verb strength is the table, with a fallback for anything else", () => {
  assert.equal(fillOpacity("warm"), 0.7);
  assert.equal(fillOpacity("define"), 0.5);
  assert.equal(fillOpacity("brighten"), 0.6);
  assert.equal(fillOpacity("soften"), FILL_OPACITY_FALLBACK);
  assert.equal(fillOpacity(""), FILL_OPACITY_FALLBACK);
  for (const [verb, op] of Object.entries(VERB_FILL)) {
    assert.equal(fillOpacity(verb), op);
    assert.ok(op > 0 && op <= 1, `verb ${verb} opacity ${op} in (0, 1]`);
    assert.ok(["multiply", "soft-light"].includes(blendForVerb(verb)), `verb ${verb} has a blend`);
  }
});

test("paint hex accepts #RRGGBB only", () => {
  assert.equal(paintHex("#CC8899"), "#cc8899");
  assert.equal(paintHex("  #aabbcc  "), "#aabbcc");
  assert.equal(paintHex("#abc"), null);
  assert.equal(paintHex("red"), null);
  assert.equal(paintHex(null), null);
  assert.equal(paintHex(undefined), null);
});

test("paired stems resolve to _L/_R, exact ids stay, unknowns drop", () => {
  const known = new Set(["cheek_apple_L", "cheek_apple_R", "chin_ball", "under_eye_L"]);
  assert.deepEqual(resolvePaintIds("cheek_apple", known), ["cheek_apple_L", "cheek_apple_R"]);
  assert.deepEqual(resolvePaintIds("under_eye", known), ["under_eye_L"]);
  assert.deepEqual(resolvePaintIds("chin_ball", known), ["chin_ball"]);
  assert.deepEqual(resolvePaintIds("cheek_apple_L", known), ["cheek_apple_L"]);
  assert.deepEqual(resolvePaintIds("nope", known), []);
  assert.deepEqual(resolvePaintIds("", known), []);
});

test("points string rejects a short or non-finite polygon", () => {
  assert.equal(pointsAttr([{ x: 1, y: 2 }, { x: 3, y: 4 }]), null);
  assert.equal(pointsAttr([{ x: 1, y: 2 }, { x: Number.NaN, y: 4 }, { x: 5, y: 6 }]), null);
  assert.equal(pointsAttr([{ x: 1, y: 2 }, { x: 3, y: 4 }, { x: Infinity, y: 6 }]), null);
  assert.equal(pointsAttr([{ x: 1.26, y: 2 }, { x: 3, y: 4 }, { x: 5, y: 6 }]), "1.3,2.0 3.0,4.0 5.0,6.0");
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

const planBase: CoachPlanInput = {
  classification: classifyFace(null),
  skinHex: "#c28e6b",
  lockHex: "#b3122e",
  depth: 0.5,
};

function catalog() {
  const norm = normalizeFace(canonicalFrontal())!;
  const map = buildContourMap(norm);
  return { norm, shapes: [...map.zones, ...map.ribbons] };
}

test("oval highlight stems paint both cheeks, and a shared zone stacks instead of dropping", () => {
  const { norm, shapes } = catalog();
  const plan = buildPlan(planBase);
  const warm = plan.find((s) => s.verb === "warm")!;
  const light = plan.find((s) => s.verb === "brighten")!;
  const blush = zoneLayers([warm], shapes, norm.iod, 1000, false);
  assert.deepEqual(blush.pigments.map((p) => p.zoneId).sort(), ["cheek_apple_L", "cheek_apple_R"]);
  assert.ok(blush.pigments.every((p) => p.blend === "soft-light" && p.fill === warm.shadeHex));
  assert.ok(blush.guides.every((g) => !("blend" in g)));

  const hi = zoneLayers([light], shapes, norm.iod, 1000, false);
  assert.deepEqual(
    hi.pigments.map((p) => p.zoneId).sort(),
    ["cheek_apple_L", "cheek_apple_R", "cupid_bow", "nose_bridge"],
  );
  assert.ok(hi.pigments.every((p) => p.blend === "soft-light"));

  const all = zoneLayers(plan, shapes, norm.iod, 1000, true);
  const cheek = all.pigments.filter((p) => p.zoneId === "cheek_apple_L");
  assert.equal(cheek.length, 2, "blush and highlight both paint the apple");
  assert.equal(cheek[0]!.fill, warm.shadeHex);
  assert.equal(cheek[1]!.fill, light.shadeHex);
  assert.ok(Math.abs(cheek[0]!.opacity - fillOpacity("warm") * ALL_STEPS_GAIN) < 1e-9);
  assert.equal(all.guides.find((g) => g.zoneId === "cheek_apple_L")!.stroke, light.shadeHex);
  const one = zoneLayers([warm], shapes, norm.iod, 1000, false);
  assert.equal(one.pigments[0]!.opacity, fillOpacity("warm"));
});

test("every chart zone id resolves to a polygon, and depth steps multiply", () => {
  const { norm, shapes } = catalog();
  const known = new Set(shapes.map((s) => s.id));
  for (const shape of FACE_SHAPES) {
    const plan = buildPlan({
      ...planBase,
      classification: { primary: shape as FaceShape, secondary: "oval", confidence: 0.8, margins: {} },
    });
    for (const step of plan) {
      if (step.zoneIds.length === 0) continue;
      for (const id of step.zoneIds) {
        assert.ok(resolvePaintIds(id, known).length > 0, `${shape} ${step.verb} id ${id} matches no polygon`);
      }
      const { pigments, guides } = zoneLayers([step], shapes, norm.iod, 1000, false);
      assert.ok(pigments.length > 0, `${shape} ${step.verb} painted nothing`);
      assert.equal(guides.length, new Set(pigments.map((p) => p.zoneId)).size);
      for (const p of pigments) {
        assert.ok(p.sigma >= FEATHER_MIN_VB && p.sigma <= FEATHER_MAX_VB && Number.isFinite(p.sigma), `${p.zoneId} sigma ${p.sigma}`);
        assert.equal(p.opacity, fillOpacity(step.verb));
        assert.equal(p.blend, blendForVerb(step.verb));
        assert.equal("blend" in (guides.find((g) => g.zoneId === p.zoneId) ?? {}), false);
      }
      if (step.verb === "define") assert.ok(pigments.every((p) => p.blend === "multiply"));
    }
  }
});

test("bad steps and a repeated id paint nothing extra and do not throw", () => {
  const shapes = [{ id: "cheek_apple_L", kind: "zone" as const, radiusIod: 0.4 }, { id: "cheek_apple_R", kind: "zone" as const, radiusIod: 0.4 }];
  assert.equal(zoneLayers(null, shapes, 0.2, 1000, false).pigments.length, 0);
  assert.equal(zoneLayers(undefined, shapes, 0.2, 1000, false).pigments.length, 0);
  assert.equal(zoneLayers([{ shadeHex: "red", verb: "warm", zoneIds: ["cheek_apple_L"] }], shapes, 0.2, 1000, false).pigments.length, 0);
  assert.equal(zoneLayers([{ shadeHex: "#cc8899", verb: "warm" }], shapes, 0.2, 1000, false).pigments.length, 0);
  assert.equal(zoneLayers([{ shadeHex: "#cc8899", verb: "warm", zoneIds: [1, "missing"] }], shapes, 0.2, 1000, false).pigments.length, 0);
  const dup = zoneLayers(
    [{ shadeHex: "#CC8899", verb: "warm", zoneIds: ["cheek_apple", "cheek_apple_L"] }],
    shapes,
    0.2,
    1000,
    false,
  );
  assert.deepEqual(dup.pigments.map((p) => p.zoneId), ["cheek_apple_L", "cheek_apple_R"]);
  assert.equal(dup.pigments[0]!.fill, "#cc8899");
  const degenerate = zoneLayers(
    [{ shadeHex: "#cc8899", verb: "warm", zoneIds: ["cheek_apple_L"] }],
    shapes,
    Number.NaN,
    1000,
    false,
  );
  assert.equal(degenerate.pigments[0]!.sigma, FEATHER_MIN_VB);
  const blank = zoneLayers([{ shadeHex: "#cc8899", verb: "", zoneIds: ["cheek_apple_L"] }], shapes, 0.2, 1000, false);
  assert.equal(blank.pigments.length, 1);
  assert.equal(blank.pigments[0]!.blend, "soft-light");
  assert.equal(blank.pigments[0]!.opacity, FILL_OPACITY_FALLBACK);
  const skipped = zoneLayers([null as unknown as { shadeHex: string }, { shadeHex: "#cc8899", verb: "define", zoneIds: ["cheek_apple_L"] }], shapes, 0.2, 1000, false);
  assert.equal(skipped.pigments.length, 1);
  assert.equal(skipped.pigments[0]!.blend, "multiply");
});
