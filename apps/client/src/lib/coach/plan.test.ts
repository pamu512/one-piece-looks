/**
 * Tests for coach/plan.ts - step construction, shade parity with the server
 * formulas, copy stance, ordering, and oily-skin behavior.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { classifyFace, FACE_SHAPES, type FaceShape } from "./faceShape.ts";
import { buildPlan, rules, type CoachPlanInput } from "./plan.ts";
import { deriveShades, luminance, mix } from "./shades.ts";

const base: CoachPlanInput = {
  classification: classifyFace(null), // balanced/oval default
  skinHex: "#c28e6b",
  lockHex: "#b3122e",
  depth: 0.5,
};

test("oval default builds the full 4-step plan in MUA order", () => {
  const plan = buildPlan(base);
  // oval (schema 3): light temple+shelf contour, blush, brow, highlight —
  // "enhance, don't reshape" still lights the temples per the cited guide.
  assert.equal(plan.length, 4, `steps: ${plan.map((s) => s.verb).join(",")}`);
  assert.equal(plan[0]!.verb, "define");
  assert.equal(plan[1]!.verb, "warm");
  assert.equal(plan[2]!.verb, "define");
  assert.equal(plan[3]!.verb, "brighten");
});

test("every shape in rules.json produces a non-empty plan", () => {
  for (const shape of Object.keys(rules.shapes)) {
    const plan = buildPlan({ ...base, classification: { primary: shape as never, secondary: "oval", confidence: 0.8, margins: {} } });
    assert.ok(plan.length >= 2, `${shape}: ${plan.length} steps`);
    const ribbons = rules.shapes[shape as FaceShape]?.contour?.ribbons ?? [];
    assert.deepEqual(plan[0]!.zoneIds.slice().sort(), ribbons.slice().sort(), `${shape} contour`);
    for (const id of ribbons) {
      assert.equal(typeof rules.brushDirections[id], "string", `${shape} ribbon ${id}`);
    }
    for (const s of plan) {
      assert.ok(s.zoneIds !== undefined, `${shape} step has zoneIds`);
      assert.ok(s.oneSentence.length > 0 && s.oneSentence.endsWith("."), `${shape} sentence complete`);
      assert.ok(/^#[0-9a-f]{6}$/.test(s.shadeHex), `${shape} shade hex well-formed`);
      assert.ok(s.brushDirection.length > 0, `${shape} brush direction present`);
    }
  }
});

test("nine labels resolve their own rules", () => {
  assert.equal(rules.schema, 4); // 4: blush motions + application order added
  assert.deepEqual([...Object.keys(rules.shapes)].sort(), [...FACE_SHAPES].sort());
  assert.equal("long" in rules.shapes, false);
  assert.equal("triangle" in rules.shapes, false);
  for (const shape of ["oblong", "rectangle", "pear", "invTriangle"] as const) {
    assert.match(JSON.stringify(rules.shapes[shape]), /e\.l\.f\./);
  }
});

test("an unknown primary uses the oval chart", () => {
  const oval = contourIds("oval").slice().sort();
  const unknown = buildPlan({
    ...base,
    classification: { primary: "nope" as FaceShape, secondary: "oval", confidence: 0, margins: {} },
  })[0]!.zoneIds.slice().sort();
  assert.deepEqual(unknown, oval);
});

function contourIds(shape: FaceShape): string[] {
  return buildPlan({
    ...base,
    classification: { primary: shape, secondary: "oval", confidence: 0.8, margins: {} },
  })[0]!.zoneIds;
}

test("oblong, rectangle, pear, and invTriangle do not fall through to oval", () => {
  const oval = contourIds("oval").slice().sort();
  assert.deepEqual(contourIds("oblong").slice().sort(), ["hairline_top", "under_chin"]);
  assert.deepEqual(contourIds("rectangle").slice().sort(), ["hairline_top", "under_chin"]);
  assert.deepEqual(contourIds("pear").slice().sort(), ["jaw_L", "jaw_R"]);
  for (const shape of ["oblong", "rectangle", "pear"] as const) {
    assert.notDeepEqual(contourIds(shape).slice().sort(), oval, `${shape} used the oval contour`);
  }
  const inv = contourIds("invTriangle");
  assert.ok(inv.includes("temple_L") && inv.includes("temple_R"), inv.join(","));
  assert.equal(inv.includes("jaw_L"), false);
  const invLight = buildPlan({
    ...base,
    classification: { primary: "invTriangle", secondary: "oval", confidence: 0.8, margins: {} },
  }).find((s) => s.verb === "brighten")!;
  assert.ok(invLight.zoneIds.includes("chin_ball"));
  const ovalLight = buildPlan(base).find((s) => s.verb === "brighten")!;
  assert.equal(ovalLight.zoneIds.includes("chin_ball"), false);
  for (const shape of ["oblong", "rectangle"] as const) {
    const plan = buildPlan({
      ...base,
      classification: { primary: shape, secondary: "oval", confidence: 0.8, margins: {} },
    });
    assert.match(plan[0]!.oneSentence, /horizontal/);
    const light = plan.find((s) => s.verb === "brighten")!;
    assert.deepEqual(light.zoneIds, ["cheek_apple"]);
    assert.equal(light.zoneIds.includes("chin_ball"), false);
  }
});

test("round plan lights temple+jaw ribbons and high angled blush", () => {
  const plan = buildPlan({
    ...base,
    classification: { primary: "round", secondary: "oval", confidence: 0.7, margins: {} },
  });
  const contour = plan[0]!;
  assert.deepEqual(
    contour.zoneIds.sort(),
    ["jaw_L", "jaw_R", "temple_L", "temple_R", "cheek_shelf_L", "cheek_shelf_R"].sort(),
  );
  const blush = plan[1]!;
  assert.deepEqual(blush.zoneIds, ["cheek_apple_L", "cheek_apple_R"]);
});

test("shade hexes match the server palettes() formulas exactly", () => {
  const skin = "#c28e6b", lock = "#b3122e", depth = 0.5;
  const plan = buildPlan({ ...base, skinHex: skin, lockHex: lock, depth });
  const want = deriveShades(skin, lock, depth);
  const byVerb = (v: string) => plan.find((s) => s.verb === v)!;
  const lastByVerb = (v: string) => [...plan].reverse().find((s) => s.verb === v)!;
  assert.equal(byVerb("warm").shadeHex, want.blush);
  // two define steps now (contour, then brow): the LAST is the brow shade
  assert.equal(lastByVerb("define").shadeHex, want.brow);
  assert.equal(byVerb("brighten").shadeHex, want.highlight);
  // server parity, computed inline: contour = mix(skin, #5c3a28, 0.35+d*0.2)
  assert.equal(want.contour, mix(skin, "#5c3a28", 0.35 + depth * 0.2));
  assert.equal(want.brow, mix(skin, "#2f1c10", 0.55 + depth * 0.15));
  assert.equal(want.highlight, mix(skin, "#fff3e2", 0.4 - depth * 0.15));
});

test("lock drives the blush family shift like the server", () => {
  // pink family: shiftHue(lock, -18) mixed 15% into skin
  const pinkLock = "#e8a5b0";
  const plan = buildPlan({ ...base, lockHex: pinkLock });
  const blushStep = plan.find((s) => s.verb === "warm")!;
  assert.equal(blushStep.shadeHex, deriveShades(base.skinHex, pinkLock, base.depth).blush);
  // a red lock and a peach lock must land on different blush hexes
  const peach = buildPlan({ ...base, lockHex: "#f0a060" }).find((s) => s.verb === "warm")!.shadeHex;
  const red = buildPlan({ ...base, lockHex: "#c01830" }).find((s) => s.verb === "warm")!.shadeHex;
  assert.notEqual(peach, red);
});

test("copy stance: no step sentence carries flaw language", () => {
  const banned = /\b(fix|slim|problem|flaw|reduce|correct|hide|disguise|narrow|shrink|minimize)\b/i;
  for (const shape of Object.keys(rules.shapes)) {
    for (const s of buildPlan({ ...base, classification: { primary: shape as never, secondary: "oval", confidence: 1, margins: {} } })) {
      assert.ok(!banned.test(s.oneSentence), `${shape}: "${s.oneSentence}"`);
      assert.ok(!banned.test(s.verb), `${shape} verb "${s.verb}"`);
    }
  }
});

test("oily skin: matte note replaces the dewy highlight step", () => {
  const plan = buildPlan({ ...base, oily: true });
  const brighten = plan.find((s) => s.verb === "brighten");
  assert.equal(brighten, undefined, "no dewy highlight step on oily skin");
  const matte = plan.find((s) => s.oneSentence.includes("matte"));
  assert.ok(matte, "the plan explains the matte choice");
  assert.equal(matte!.zoneIds.length, 0, "no glow zones lit on oily skin");
});

test("plan is deterministic", () => {
  const a = JSON.stringify(buildPlan(base));
  const b = JSON.stringify(buildPlan({ ...base }));
  assert.equal(a, b);
});

test("depth derives from skin luminance like the server when not handed one", () => {
  const deep = 1 - luminance("#7d523a") * 1.15;
  const planA = buildPlan({ ...base, skinHex: "#7d523a", depth: deep });
  const planB = buildPlan({ ...base, skinHex: "#7d523a", depth: deep });
  assert.equal(planA[0]!.shadeHex, planB[0]!.shadeHex);
  // plan[0] is the contour step (schema 3): its shade is the contour mix
  assert.equal(planA[0]!.shadeHex, deriveShades("#7d523a", base.lockHex, deep).contour);
  // the blush shade is unchanged by the new step order
  const blushA = planA.find((s) => s.verb === "warm")!;
  assert.equal(blushA.shadeHex, deriveShades("#7d523a", base.lockHex, deep).blush);
});
