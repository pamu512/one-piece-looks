/**
 * Tests for faceParse.ts's pure reduction: per-pixel softmax over the 19
 * bisenet classes into the skin / lip / occlusion planes the mask math
 * consumes. The DOM + onnxruntime path is covered by the pixel probe
 * (demos/probe-soft-fills.mjs); here only the algebra.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { PARSE_CLASS_COUNT, PARSE_SIZE, planesFromLogits } from "./faceParse.ts";

const N = PARSE_SIZE * PARSE_SIZE;

/** Logits plane where class c carries value v everywhere, others 0. */
function constantLogits(c: number, v: number): Float32Array {
  const lg = new Float32Array(PARSE_CLASS_COUNT * N);
  lg.fill(v, c * N, (c + 1) * N);
  return lg;
}

test("softmax picks the dominant class with the expected probability", () => {
  // skin=2, hair=1, bg=0.5, the other 16 classes at 0
  const lg = constantLogits(1, 2);
  lg.fill(1, 17 * N, 18 * N);
  lg.fill(0.5, 0, N);
  const planes = planesFromLogits(lg);
  assert.ok(planes);
  const denom = Math.exp(2) + Math.exp(1) + Math.exp(0.5) + 16;
  assert.ok(Math.abs(planes.skin[0]! - Math.exp(2) / denom) < 1e-6);
  // both lip classes sit at logit 0: p(lip) = 2 e^0 / denom
  assert.ok(Math.abs(planes.lip[0]! - 2 / denom) < 1e-6);
  assert.ok(Math.abs(planes.occ[0]! - Math.exp(1) / denom) < 1e-6, "occ is max(hair, bg)");
});

test("lip plane sums u_lip and l_lip", () => {
  const lg = constantLogits(12, 3);
  lg.fill(2.5, 13 * N, 14 * N);
  const planes = planesFromLogits(lg);
  assert.ok(planes);
  const denom = Math.exp(3) + Math.exp(2.5) + 17;
  assert.ok(Math.abs(planes.lip[0]! - (Math.exp(3) + Math.exp(2.5)) / denom) < 1e-6);
  assert.ok(Math.abs(planes.skin[0]! - 1 / denom) < 1e-6);
  assert.ok(Math.abs(planes.occ[0]! - 1 / denom) < 1e-6);
});

test("uniform logits give uniform 1/19 probabilities", () => {
  const planes = planesFromLogits(new Float32Array(PARSE_CLASS_COUNT * N).fill(-1.7));
  assert.ok(planes);
  assert.ok(Math.abs(planes.skin[7]! - 1 / 19) < 1e-6);
  assert.ok(Math.abs(planes.lip[7]! - 2 / 19) < 1e-6);
  assert.ok(Math.abs(planes.occ[7]! - 1 / 19) < 1e-6);
});

test("occlusion prefers the larger of hair and background", () => {
  const bg = planesFromLogits(constantLogits(0, 4))!;
  assert.ok(Math.abs(bg.occ[123]! - Math.exp(4) / (Math.exp(4) + 18)) < 1e-6);
  const both = constantLogits(0, 1);
  both.fill(2, 17 * N, 18 * N);
  const planes = planesFromLogits(both)!;
  const denom = Math.exp(1) + Math.exp(2) + 17;
  assert.ok(Math.abs(planes.occ[123]! - Math.exp(2) / denom) < 1e-6);
});

test("wrong class count or non-finite rows resolve safely", () => {
  assert.equal(planesFromLogits(new Float32Array(18 * N)), null, "18-class graph rejected");
  assert.equal(planesFromLogits(new Float32Array(20 * N)), null, "20-class graph rejected");
  // NaN in exactly one pixel's skin logit (plane 1 starts at N): that
  // pixel reads zero probability, its neighbors are unaffected
  const mixed = constantLogits(1, 3);
  mixed[N] = Number.NaN;
  const planes = planesFromLogits(mixed)!;
  const denom = Math.exp(3) + 18;
  assert.equal(planes.skin[0]!, 0, "NaN logit reads as zero probability");
  assert.ok(Math.abs(planes.skin[1]! - Math.exp(3) / denom) < 1e-6, "other pixels unaffected");
  assert.ok(Number.isFinite(planes.occ[0]!));
});
