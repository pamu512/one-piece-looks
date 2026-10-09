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
  selectLipPolygon,
} from "./faceFrame.ts";
import type { FaceBox } from "./face.ts";


const here = dirname(fileURLToPath(import.meta.url));
const bandsJson = JSON.parse(readFileSync(join(here, "face-bands.json"), "utf8")) as {
  train: { n: number };
  test: {
    n: number;
    mouth_y: { p5: number; p95: number };
    eye_y: { mean: number };
    brow_y: { mean: number };
  };
};

test("WFLW band constants derive from the test split (2500 faces)", () => {
  assert.equal(bandsJson.test.n, 2500);
  assert.equal(bandsJson.train.n, 7500);
  // Mouth band: p5 widened down by 0.04, p95 widened up by 0.03.
  assert.equal(MOUTH_BAND.y0, Math.floor((bandsJson.test.mouth_y.p5 - 0.04) * 100) / 100);
  assert.equal(MOUTH_BAND.y1, Math.ceil((bandsJson.test.mouth_y.p95 + 0.03) * 100) / 100);
  // Eye band starts below the brow midline and ends near the iris, not at p5.
  assert.equal(EYE_BAND.y0, Math.ceil((bandsJson.test.brow_y.mean + 0.05) * 100) / 100);
  assert.equal(EYE_BAND.y1, Math.ceil((bandsJson.test.eye_y.mean + 0.10) * 100) / 100);
  // WFLW reality check: mouth sits below eyes, and the brow is above the eye band.
  assert.ok(MOUTH_BAND.y0 > EYE_BAND.y1);
  assert.ok(BROW_MID_Y < EYE_BAND.y0);
});

test("eyebrow-high centers fall outside the eye band", () => {
  const fb: FaceBox = { x: 0.15, y: 0.1, w: 0.7, h: 0.75 };
  const band = eyeBand(fb);
  const browY = fb.y + fb.h * BROW_MID_Y;
  const irisY = fb.y + fb.h * ((EYE_BAND.y0 + EYE_BAND.y1) / 2);
  assert.ok(browY < band.y0, "brow midline is above the iris search");
  assert.ok(irisY > band.y0 && irisY < band.y1, "iris height stays inside the band");
  const rel = (y: number) => (y - fb.y) / fb.h;
  assert.ok(rel(browY) < EYE_BAND.y0);
  assert.ok(rel(irisY) >= EYE_BAND.y0 && rel(irisY) <= EYE_BAND.y1);
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

test("lip polygon follows the redness peak, not a broader dimmer patch", () => {
  const w = 100, h = 125;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const score = (x: number, y: number) => {
    // Nose sits inside the mouth band and is broader, but dimmer.
    const nose = Math.max(0, 28 - Math.hypot(x - 50, y - 76) * 0.35);
    const lip = Math.max(0, 50 - Math.hypot((x - 50) / 1.3, (y - 92) / 0.65));
    return Math.max(nose, lip);
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 3);
  let sx = 0, sy = 0;
  for (const [x, y] of poly!) { sx += x; sy += y; }
  const cy = sy / poly!.length;
  assert.ok(cy > 0.68 && cy < 0.80, `lip centroid y ${cy}`);
  assert.equal(inside(poly!, 0.5, 92.5 / 125), true);
  assert.equal(inside(poly!, 0.5, 70 / 125), false);
});

test("a hot speck beside the mouth does not pull the lip polygon off the lip", () => {
  const w = 200, h = 250;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const lipX = 90, lipY = 185;
  const score = (x: number, y: number) => {
    const lip = Math.max(0, 80 - Math.hypot((x - lipX) / 0.45, (y - lipY) / 0.28));
    const speck = x === 148 && y === lipY ? 500 : 0;
    return Math.max(lip, speck);
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 3);
  assert.equal(inside(poly!, (lipX + 0.5) / w, (lipY + 0.5) / h), true, "lip center stays inside the fill");
  let sx = 0, sy = 0;
  for (const [x, y] of poly!) { sx += x; sy += y; }
  const cx = sx / poly!.length;
  const cy = sy / poly!.length;
  assert.ok(Math.abs(cx - (lipX + 0.5) / w) < 0.06, `centroid x ${cx} drifted toward the speck`);
  assert.ok(Math.abs(cy - (lipY + 0.5) / h) < 0.04, `centroid y ${cy}`);
  assert.equal(inside(poly!, 148.5 / w, (lipY + 0.5) / h), false, "speck is outside the lip fill");
});

test("lip polygon follows the vermillion notch instead of the convex hull", () => {
  const w = 100, h = 125;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const cx = 50, cy = 92, rx = 14, ry = 5;
  const score = (x: number, y: number) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    const inLip = nx * nx + ny * ny <= 1;
    const notch = Math.abs(x - cx) <= 4 && y < cy - 1;
    return inLip && !notch ? 90 : 0;
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 3);
  assert.equal(inside(poly!, cx / w, cy / h), true, "lip center stays inside");
  // Below the shoulder line, inside the hull of the ellipse, inside the cut.
  assert.equal(inside(poly!, cx / w, (cy - 2) / h), false, "cupid notch stays empty");
  assert.ok(poly!.length <= 64, `outline has ${poly!.length} points`);
});

test("lip polygon drops the dim mouth rectangle and keeps the hot vermillion", () => {
  const w = 200, h = 250;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const cx = 100, cy = 185, rx = 22, ry = 8;
  const score = (x: number, y: number) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    if (nx * nx + ny * ny <= 1) return 100;
    if (Math.abs(x - cx) <= 40 && Math.abs(y - cy) <= 16) return 62;
    return 0;
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 8, `outline has ${poly?.length ?? 0} points`);
  assert.equal(inside(poly!, cx / w, cy / h), true, "vermillion center stays inside");
  assert.equal(inside(poly!, cx / w, 171 / h), false, "dimmer skin above the lip stays outside");
});

test("lip polygon keeps the hot lip and leaves 42 percent skin outside it", () => {
  const w = 200, h = 250;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const cx = 100, cy = 185, rx = 18, ry = 6;
  const score = (x: number, y: number) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    if (nx * nx + ny * ny <= 1) return 100;
    if (Math.abs(x - cx) <= 70 && Math.abs(y - cy) <= 14) return 42;
    return 0;
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 8, `outline has ${poly?.length ?? 0} points`);
  assert.equal(inside(poly!, cx / w, cy / h), true, "lip center stays inside");
  assert.equal(inside(poly!, cx / w, (cy - 12) / h), false, "42 percent skin above the lip stays outside");
});

test("lip polygon keeps cooler commissures and excludes skin past the vermillion", () => {
  const w = 200, h = 250;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const cx = 100, cy = 185, rx = 22, ry = 8;
  const score = (x: number, y: number) => {
    const nx = (x - cx) / rx;
    const ny = (y - cy) / ry;
    const e = nx * nx + ny * ny;
    if (e <= 0.45) return 100;
    if (e <= 1) return 48;
    return 0;
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 3);
  assert.equal(inside(poly!, cx / w, cy / h), true, "lip center stays inside");
  assert.equal(inside(poly!, (cx + rx - 1) / w, cy / h), true, "cooler commissure stays inside");
  assert.equal(inside(poly!, (cx + rx + 4) / w, cy / h), false, "skin past the vermillion stays outside");
});

test("upper and lower lip join across a one-cell gap without a dilated skirt", () => {
  const w = 200, h = 250;
  const fb: FaceBox = { x: 0, y: 0, w: 1, h: 1 };
  const score = (x: number, y: number) => {
    const upper = x >= 80 && x <= 120 && y >= 176 && y <= 180;
    const lower = x >= 80 && x <= 120 && y >= 184 && y <= 188;
    return upper || lower ? 90 : 0;
  };
  const poly = selectLipPolygon(w, h, fb, score);
  assert.ok(poly && poly.length >= 3);
  assert.equal(inside(poly!, 100 / w, 178 / h), true, "upper lip stays inside");
  assert.equal(inside(poly!, 100 / w, 186 / h), true, "lower lip stays inside");
  assert.equal(inside(poly!, 100 / w, 174 / h), false, "the cell above the upper lip stays outside");
});

function inside(poly: ReadonlyArray<readonly [number, number]>, x: number, y: number): boolean {
  let hit = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i]!, [xj, yj] = poly[j]!;
    if (((yi > y) !== (yj > y)) && (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) hit = !hit;
  }
  return hit;
}
