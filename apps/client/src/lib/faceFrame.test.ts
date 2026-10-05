/**
 * Unit tests for the face-frame-first pure geometry (lib/faceFrame.ts) and
 * the WFLW band constants, runnable under node (npm test at the root runs
 * the server suite; this file runs via apps/client's own test script and
 * both are wired into `npm test` through the workspace).
 *
 * Covers: band values match the WFLW face-bands.json test split, mouth/eye
 * bands stay inside their parent faceBox, the hand-band clamp, portrait
 * aspect rejection, and the model > skin > prior decision ladder.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import test from "node:test";

import {
  BROW_MID_Y, EYE_BAND, HAND_BAND_Y, MOUTH_BAND,
  clampCenterInBand, clampFaceBox, decideFaceBox, eyeBand, mouthBand, portraitPriorFaceBox,
} from "./faceFrame.ts";
import type { FaceBox } from "./face.ts";


const here = dirname(fileURLToPath(import.meta.url));
const bandsJson = JSON.parse(readFileSync(join(here, "face-bands.json"), "utf8")) as {
  train: { n: number }; test: { n: number; mouth_y: { p5: number; p95: number }; eye_y: { p5: number; p95: number } };
};

test("WFLW band constants derive from the test split (2500 faces)", () => {
  assert.equal(bandsJson.test.n, 2500);
  assert.equal(bandsJson.train.n, 7500);
  // Mouth band: p5 widened down by 0.04, p95 widened up by 0.03.
  assert.equal(MOUTH_BAND.y0, Math.floor((bandsJson.test.mouth_y.p5 - 0.04) * 100) / 100);
  assert.equal(MOUTH_BAND.y1, Math.ceil((bandsJson.test.mouth_y.p95 + 0.03) * 100) / 100);
  assert.equal(EYE_BAND.y0, Math.floor((bandsJson.test.eye_y.p5 - 0.03) * 100) / 100);
  assert.equal(EYE_BAND.y1, Math.ceil((bandsJson.test.eye_y.p95 + 0.03) * 100) / 100);
  // WFLW reality check: mouth sits below eyes inside any face box.
  assert.ok(MOUTH_BAND.y0 > EYE_BAND.y1);
  assert.ok(BROW_MID_Y < EYE_BAND.y0 + 0.1);
});

test("clampCenterInBand keeps the patch inside the band", () => {
  assert.equal(clampCenterInBand(0.5, 0.2, 0.8, 0.05), 0.5);
  assert.equal(clampCenterInBand(0.22, 0.2, 0.8, 0.05), 0.25);
  assert.equal(clampCenterInBand(0.9, 0.2, 0.8, 0.05), 0.75);
  // Band thinner than the patch: midpoint, still inside.
  assert.equal(clampCenterInBand(0.1, 0.4, 0.46, 0.05), (0.4 + 0.46) / 2);
});

test("mouth and eye bands stay inside their parent faceBox", () => {
  const fb: FaceBox = { x: 0.2, y: 0.1, w: 0.6, h: 0.7 };
  const m = mouthBand(fb);
  const e = eyeBand(fb);
  for (const band of [m, e]) {
    assert.ok(band.x0 >= fb.x - 1e-9 && band.x1 <= fb.x + fb.w + 1e-9);
    assert.ok(band.y0 >= fb.y - 1e-9 && band.y1 <= fb.y + fb.h + 1e-9);
    assert.ok(band.x1 > band.x0 && band.y1 > band.y0);
  }
  // WFLW mouth band of this box lands in the classic lower-face region.
  assert.ok(m.y0 > 0.5 && m.y1 < 0.95);
});

test("mouth band of a degenerate tiny box is still ordered and in-box", () => {
  const fb: FaceBox = { x: 0.45, y: 0.3, w: 0.1, h: 0.15 };
  const m = mouthBand(fb);
  assert.ok(m.y0 >= fb.y && m.y1 <= fb.y + fb.h);
  assert.ok(m.x0 >= fb.x && m.x1 <= fb.x + fb.w);
});

test("clampFaceBox rejects non-portrait and unusable shapes", () => {
  assert.ok(clampFaceBox({ x: 0.2, y: 0.1, w: 0.6, h: 0.7 }), "aspect 1.17 is portrait enough");
  assert.equal(clampFaceBox({ x: 0.1, y: 0.1, w: 0.8, h: 0.6 }), null, "landscape face rejected");
  // After the frame clamp h can only shrink; a candidate whose clamped
  // aspect is still extreme (tall thin sliver) is rejected.
  assert.equal(clampFaceBox({ x: 0.48, y: 0.05, w: 0.1, h: 0.3 }), null, "clamped aspect 3.0 rejected");
  assert.equal(clampFaceBox({ x: 0.4, y: 0.4, w: 0.04, h: 0.04 }), null, "tiny remnant rejected");
  const ok = clampFaceBox({ x: 0.25, y: 0.15, w: 0.5, h: 0.6 });
  assert.ok(ok, "portrait box accepted");
  assert.deepEqual(ok, { x: 0.25, y: 0.15, w: 0.5, h: 0.6 });
});

test("clampFaceBox keeps the box out of the hand band", () => {
  // Skin-grid-style box that swallows the bottom hand band.
  const clamped = clampFaceBox({ x: 0.15, y: 0.1, w: 0.7, h: 0.93 });
  assert.ok(clamped);
  assert.ok(clamped.y + clamped.h <= HAND_BAND_Y + 1e-9, "bottom stays above the hand band");
  // A candidate living entirely inside the hand band is unusable.
  assert.equal(clampFaceBox({ x: 0.3, y: 0.92, w: 0.4, h: 0.08 }), null);
  // Model confident the face fills the frame may reach the edge.
  const fills = clampFaceBox({ x: 0.1, y: 0.05, w: 0.8, h: 0.9 }, { faceFillsFrame: true });
  assert.ok(fills);
  assert.equal(fills.h, 0.9);
  // Low-confidence model box is still clamped out.
  const notFills = clampFaceBox({ x: 0.1, y: 0.05, w: 0.8, h: 0.9 });
  assert.ok(notFills);
  assert.ok(notFills.y + notFills.h <= HAND_BAND_Y + 1e-9);
});

test("decideFaceBox: model wins, skin falls through, prior is the floor", () => {
  const modelBox = { box: { x: 0.3, y: 0.12, w: 0.4, h: 0.55 }, conf: 0.8 };
  const skinBox: FaceBox = { x: 0.1, y: 0.05, w: 0.8, h: 0.9 };
  const both = decideFaceBox(modelBox, skinBox);
  assert.equal(both.source, "model");
  assert.ok(both.confident);

  const lowConf = decideFaceBox({ box: { x: 0.3, y: 0.1, w: 0.4, h: 0.55 }, conf: 0.3 }, skinBox);
  assert.equal(lowConf.source, "skin");
  assert.ok(lowConf.faceBox.y + lowConf.faceBox.h <= HAND_BAND_Y + 1e-9);

  const none = decideFaceBox(null, null);
  assert.equal(none.source, "prior");
  assert.deepEqual(none.faceBox, portraitPriorFaceBox());
  assert.equal(none.confident, false);
  // The prior is hand-band clear by construction.
  const prior = portraitPriorFaceBox();
  assert.ok(prior.y + prior.h < HAND_BAND_Y);
  assert.ok(prior.y > 0.05 && prior.y + prior.h < 0.95);
});
