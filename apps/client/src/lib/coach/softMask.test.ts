/**
 * Tests for coach/softMask.ts - the soft pigment-mask algebra:
 * ramps gate softly (full pigment on clear skin, none off-face, never
 * NaN), hair/background occlusion suppresses, the blur feathers without
 * inventing energy, and the combined mask can only remove pigment the
 * zone polygon already had.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  GATE_BLUR_PX,
  LIP_GATE,
  OCC_GATE,
  SKIN_GATE,
  blurPlane,
  buildMaskKit,
  featherFilter,
  gateForZone,
  lipGate,
  maskAlpha,
  occlusionGate,
  ramp,
  skinGate,
  type MaskKit,
} from "./softMask.ts";

test("ramp is clamped, linear, and NaN-safe", () => {
  assert.equal(ramp(0, 0.35, 0.75), 0);
  assert.equal(ramp(0.35, 0.35, 0.75), 0);
  assert.equal(ramp(0.75, 0.35, 0.75), 1);
  assert.equal(ramp(1, 0.35, 0.75), 1);
  assert.ok(Math.abs(ramp(0.55, 0.35, 0.75) - 0.5) < 1e-12);
  assert.equal(ramp(Number.NaN, 0.35, 0.75), 0);
  assert.equal(ramp(Infinity, 0.35, 0.75), 1);
  assert.equal(ramp(-Infinity, 0.35, 0.75), 0);
  // degenerate band is a step at hi, not a divide-by-zero
  assert.equal(ramp(0.4, 0.5, 0.5), 0);
  assert.equal(ramp(0.6, 0.5, 0.5), 1);
});

test("class gates match the plan constants, occlusion inverts", () => {
  for (const [p, want] of [[0, 0], [SKIN_GATE[0], 0], [SKIN_GATE[1], 1], [0.95, 1]] as const) {
    assert.equal(skinGate(p), want, `skinGate(${p})`);
    assert.equal(lipGate(p), want, `lipGate(${p})`);
  }
  // occlusion: 1 on clear skin, 0 in solid hair/background, soft between
  assert.equal(occlusionGate(0), 1);
  assert.equal(occlusionGate(OCC_GATE[0]), 1);
  assert.equal(occlusionGate(OCC_GATE[1]), 0);
  assert.equal(occlusionGate(0.95), 0);
  assert.ok(Math.abs(occlusionGate((OCC_GATE[0]! + OCC_GATE[1]!) / 2) - 0.5) < 1e-12);
  // the demo's lip ramp: clip((p12 + p13 - 0.35) / 0.4)
  assert.ok(Math.abs(lipGate(0.55) - (0.55 - LIP_GATE[0]!) / (LIP_GATE[1]! - LIP_GATE[0]!)) < 1e-12);
});

test("gate choice: lip-color zones use the lip plane, everything else skin", () => {
  assert.equal(gateForZone("cheek_apple_L"), "skin");
  assert.equal(gateForZone("forehead_center"), "skin");
  // the cupid-bow highlight belongs on the skin above the lip, not the lip
  assert.equal(gateForZone("cupid_bow"), "skin");
  assert.equal(gateForZone("temple_R"), "skin");
  assert.equal(gateForZone("lip_full"), "lip");
  assert.equal(gateForZone("lips"), "lip");
  assert.equal(gateForZone(""), "skin");
});

test("blur feathers a step without inventing energy or moving a constant", () => {
  const S = 32;
  const step = new Float32Array(S * S);
  for (let i = 0; i < S * S; i++) step[i] = i % 2 ? 1 : 0; // checkerboard
  const flat = new Float32Array(S * S).fill(0.6);
  const blurredFlat = blurPlane(flat, S, GATE_BLUR_PX);
  for (let i = 0; i < S * S; i++) {
    assert.ok(Math.abs(blurredFlat[i]! - 0.6) < 1e-6, "constant plane must not drift");
  }
  const blurred = blurPlane(step, S, GATE_BLUR_PX);
  let sum0 = 0, sum1 = 0, max0 = 0, min0 = 1;
  for (let i = 0; i < S * S; i++) {
    sum0 += step[i]!;
    sum1 += blurred[i]!;
    max0 = Math.max(max0, blurred[i]!);
    min0 = Math.min(min0, blurred[i]!);
  }
  // interior energy is preserved; contrast shrinks toward the middle
  assert.ok(Math.abs(sum1 - sum0) / sum0 < 0.05, `energy drift ${(sum1 - sum0) / sum0}`);
  assert.ok(max0 < 1 && min0 > 0, "blur must soften both sides of the step");
  // impulse spreads symmetrically
  const impulse = new Float32Array(S * S);
  impulse[(16 * S + 16)] = 1;
  const b = blurPlane(impulse, S, GATE_BLUR_PX);
  assert.ok(b[16 * S + 15]! > 0 && Math.abs(b[16 * S + 15]! - b[16 * S + 17]!) < 1e-9, "left/right symmetric");
  assert.ok(b[15 * S + 16]! > 0 && Math.abs(b[15 * S + 16]! - b[17 * S + 16]!) < 1e-9, "up/down symmetric");
  assert.ok(b[0]! === 0, "far corners stay untouched");
  // radius < 1 or wrong size is a copy, never a throw
  assert.deepEqual(Array.from(blurPlane(flat, S, 0)), Array.from(flat));
  assert.deepEqual(Array.from(blurPlane(new Float32Array(4), 2, 2)), [0, 0, 0, 0]);
});

function kitFrom(planes: { skin?: number; lip?: number; occ?: number; size?: number }): MaskKit {
  const size = planes.size ?? 4;
  const fill = (v: number | undefined): Float32Array => {
    const a = new Float32Array(size * size);
    if (v !== undefined) a.fill(v);
    return a;
  };
  return buildMaskKit({
    size,
    skin: fill(planes.skin),
    lip: fill(planes.lip),
    occ: fill(planes.occ),
  }, 1);
}

test("mask alpha keeps the skin core at full strength and zeroes occlusion", () => {
  const S = 4;
  const cov = new Float32Array(S * S).fill(1); // fully covered zone
  // clear skin, no occlusion: the step-2 look survives untouched
  const clear = kitFrom({ skin: 0.95, occ: 0.02, size: S });
  for (const a of maskAlpha(cov, clear, "skin")) assert.ok(Math.abs(a - 1) < 1e-6, "core keeps alpha 1");
  // solid hair: zero pigment, even at full coverage and full skin prob
  const hair = kitFrom({ skin: 0.9, occ: 0.95, size: S });
  for (const a of maskAlpha(cov, hair, "skin")) assert.equal(a, 0, "hair suppresses");
  // background with a confident-but-wrong skin read still suppresses
  const bg = kitFrom({ skin: 0.5, occ: 0.9, size: S });
  for (const a of maskAlpha(cov, bg, "skin")) assert.ok(a <= 0.02, `bg leak ${a}`);
  // off-skin (nose/glasses class): no occlusion but no skin either
  const other = kitFrom({ skin: 0.1, occ: 0.1, size: S });
  for (const a of maskAlpha(cov, other, "skin")) assert.equal(a, 0, "non-skin class paints nothing");
});

test("mask alpha follows the gate kind and never adds pigment", () => {
  const S = 4;
  const cov = new Float32Array(S * S).fill(0.5);
  const kit = kitFrom({ skin: 0.9, lip: 0.2, occ: 0.0, size: S });
  const skin = maskAlpha(cov, kit, "skin");
  const lip = maskAlpha(cov, kit, "lip");
  for (let i = 0; i < S * S; i++) {
    // skin gate open, lip gate closed at p=0.2 (< LIP_GATE lo)
    assert.ok(Math.abs(skin[i]! - 0.5) < 1e-6);
    assert.equal(lip[i]!, 0);
    // the mask can only scale coverage down, never up
    assert.ok(skin[i]! <= cov[i]! + 1e-9 && lip[i]! <= cov[i]! + 1e-9);
  }
  // zero coverage stays zero whatever the planes say
  const empty = kitFrom({ skin: 1, occ: 0, size: S });
  for (const a of maskAlpha(new Float32Array(S * S), empty, "skin")) assert.equal(a, 0);
});

test("mask alpha is finite on broken planes (paint nothing, never NaN)", () => {
  const S = 2;
  const kit = kitFrom({ size: S });
  kit.skin[0] = Number.NaN;
  kit.occ[1] = Number.NaN;
  const cov = new Float32Array(S * S).fill(1);
  const out = maskAlpha(cov, kit, "skin");
  for (const a of out) assert.ok(Number.isFinite(a) && a >= 0 && a <= 1);
  assert.equal(out[0], 0, "NaN skin probability must not paint");
  assert.equal(out[1], 0, "NaN occlusion must not paint");
});

test("featherFilter passes the step-2 sigma band through, clamps the rest", () => {
  // viewBox sigmas are clamped to [2.5, 30]; on the 512 grid via S / vbW
  // that band is ~[1.28, 15.36] px - always a blur in practice.
  assert.equal(featherFilter(Number.NaN), null);
  assert.equal(featherFilter(0), null);
  assert.equal(featherFilter(0.05), null, "at the cutoff: no blur");
  assert.equal(featherFilter(0.051), "blur(0.05px)");
  assert.equal(featherFilter(2.5 * (512 / 1000)), "blur(1.28px)", "FEATHER_MIN_VB on the parse grid");
  assert.equal(featherFilter(30 * (512 / 1000)), "blur(15.36px)", "FEATHER_MAX_VB on the parse grid");
  assert.equal(featherFilter(Infinity), null);
});

test("a soft boundary produces intermediate alphas (no argmax cliff)", () => {
  const S = 8;
  const skin = new Float32Array(S * S);
  const occ = new Float32Array(S * S);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      // skin probability falls left to right; occlusion rises in the last columns
      skin[y * S + x] = 0.95 - 0.12 * x;
      occ[y * S + x] = x >= S - 2 ? 0.6 : 0.05;
    }
  }
  const kit = buildMaskKit({ size: S, skin, lip: new Float32Array(S * S), occ }, 1);
  const cov = new Float32Array(S * S).fill(1);
  const a = maskAlpha(cov, kit, "skin");
  // the middle of the ramp is strictly between 0 and 1 (column 3, not the
  // fully-open column 0)
  assert.ok(a[3 * S + 3]! > 0.2 && a[3 * S + 3]! < 1, `mid-ramp alpha ${a[3 * S + 3]}`);
  assert.equal(a[3 * S]!, 1, "clear-skin column keeps full alpha");
  // somewhere between the open and closed ends the alpha decreases
  let decreases = 0;
  for (let x = 0; x < S - 1; x++) if (a[x]! > a[x + 1]! + 1e-6) decreases++;
  assert.ok(decreases >= 3, "alpha must fall off gradually, not step");
});
