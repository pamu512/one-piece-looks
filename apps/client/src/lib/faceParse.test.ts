/**
 * BiSeNet lip parse, without loading the ONNX model: crop round-trip,
 * iso-contour of a synthetic 19-class map, lip means from lip pixels only,
 * and the heuristic fallback when the parser returns null.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { withOrtLock } from "./faceModel.ts";
import {
  CROP_EXPAND,
  LIP_INNER_MIN_FRAC,
  LIP_POINT_COUNT,
  PARSE_SIZE,
  cieL,
  cieLab,
  copyLogits,
  cropToNchw,
  framePxToGrid,
  gridToFrameNorm,
  lipFractionPlausible,
  lipsFromClassProbs,
  lipsOrHeuristic,
  logitsVolumeOk,
  meanLipFleshLab,
  pointInPoly,
  sampleRgbEdge,
  softmaxClassMajor,
  squareCropForBox,
} from "./faceParse.ts";

function pointLineDist(
  p: readonly [number, number],
  a: readonly [number, number],
  b: readonly [number, number],
): number {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const len = Math.hypot(dx, dy);
  if (len === 0) return Math.hypot(p[0] - a[0], p[1] - a[1]);
  return Math.abs(dx * (a[1] - p[1]) - dy * (a[0] - p[0])) / len;
}

/** Longest chord whose interior points stay on the chord. A smooth lip is short. */
function longestStraight(poly: ReadonlyArray<readonly [number, number]>): number {
  const n = poly.length;
  let max = 0;
  for (let i = 0; i < n; i++) {
    for (let len = 3; len < n * 0.45; len++) {
      const a = poly[i]!;
      const b = poly[(i + len - 1) % n]!;
      const chord = Math.hypot(b[0] - a[0], b[1] - a[1]);
      let straight = true;
      for (let k = 1; k < len - 1; k++) {
        const p = poly[(i + k) % n]!;
        if (pointLineDist(p, a, b) > Math.max(0.002, chord * 0.04)) { straight = false; break; }
      }
      if (!straight) break;
      if (chord > max) max = chord;
    }
  }
  return max;
}

test("square crop round-trips through the 512 grid and frames the face at 50 to 60 percent", () => {
  const box = { x: 0.22, y: 0.12, w: 0.48, h: 0.62 };
  const frameW = 1000, frameH = 1250;
  const crop = squareCropForBox(box, frameW, frameH);
  assert.ok(crop);
  const faceSide = Math.max(box.w * frameW, box.h * frameH);
  const fill = faceSide / crop.size;
  assert.ok(fill > 0.5 && fill < 0.6, `face fill ${fill}`);
  assert.equal(crop.size, faceSide * CROP_EXPAND);
  const cx = (box.x + box.w / 2) * frameW;
  const cy = (box.y + box.h / 2) * frameH;
  const [gx, gy] = framePxToGrid(cx, cy, crop);
  assert.ok(Math.abs(gx - (PARSE_SIZE - 1) / 2) < 1e-6);
  assert.ok(Math.abs(gy - (PARSE_SIZE - 1) / 2) < 1e-6);
  const [nx, ny] = gridToFrameNorm(gx, gy, crop, frameW, frameH);
  assert.ok(Math.abs(nx * frameW - cx) < 1e-4);
  assert.ok(Math.abs(ny * frameH - cy) < 1e-4);
  const [ox, oy] = gridToFrameNorm(0, 0, crop, frameW, frameH);
  const back = framePxToGrid(ox * frameW, oy * frameH, crop);
  assert.ok(Math.abs(back[0]) < 1e-6);
  assert.ok(Math.abs(back[1]) < 1e-6);
});

test("a sample outside the frame repeats the edge pixel, and ImageNet NCHW matches the red primary", () => {
  const rgba = new Uint8ClampedArray(2 * 2 * 4);
  rgba[0] = 10; rgba[1] = 20; rgba[2] = 30; rgba[3] = 255;
  const edge = sampleRgbEdge(rgba, 2, 2, -8, -3);
  assert.ok(Math.abs(edge[0] - 10) < 1e-6);
  assert.ok(Math.abs(edge[1] - 20) < 1e-6);
  assert.ok(Math.abs(edge[2] - 30) < 1e-6);
  const one = new Uint8ClampedArray([255, 0, 0, 255]);
  const nchw = cropToNchw(one, 1, 1, { x: 0, y: 0, size: 1 }, 1);
  assert.equal(nchw.length, 3);
  assert.ok(Math.abs(nchw[0]! - (1 - 0.485) / 0.229) < 1e-5);
  assert.ok(Math.abs(nchw[1]! - (0 - 0.456) / 0.224) < 1e-5);
  assert.ok(Math.abs(nchw[2]! - (0 - 0.406) / 0.225) < 1e-5);
});

test("softmax over 19 classes is a distribution and peaks on the lip class", () => {
  const n = 1;
  const logits = new Float32Array(19);
  logits[12] = 6;
  const p = softmaxClassMajor(logits, 19, n);
  let sum = 0;
  for (let c = 0; c < 19; c++) sum += p[c] ?? 0;
  assert.ok(Math.abs(sum - 1) < 1e-5);
  assert.ok((p[12] ?? 0) > 0.9);
  assert.ok((p[11] ?? 0) < 0.02);
});

function inEllipse(x: number, y: number, cx: number, cy: number, rx: number, ry: number): boolean {
  const dx = (x + 0.5 - cx) / rx;
  const dy = (y + 0.5 - cy) / ry;
  return dx * dx + dy * dy <= 1;
}

test("a synthetic 19-class lip traces a dense contour, an inner mouth, and lipMeanL from lip pixels only", () => {
  const size = 128;
  const box = { x: 0.28, y: 0.18, w: 0.44, h: 0.5 };
  const frameW = 1000, frameH = 1250;
  const crop = squareCropForBox(box, frameW, frameH);
  assert.ok(crop);
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const rgb = new Uint8Array(n * 3);
  const cx = (size - 1) / 2, cy = cx;
  const lipRgb: [number, number, number] = [150, 40, 50];
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const mouth = inEllipse(x, y, cx, cy, 5, 3);
      const lip = inEllipse(x, y, cx, cy, 16, 14) && !mouth;
      if (mouth) {
        probs[11 * n + i] = 0.94;
        probs[0 * n + i] = 0.06;
        rgb[i * 3] = 250; rgb[i * 3 + 1] = 250; rgb[i * 3 + 2] = 250;
      } else if (lip) {
        probs[12 * n + i] = 0.62;
        probs[13 * n + i] = 0.33;
        probs[0 * n + i] = 0.05;
        rgb[i * 3] = lipRgb[0]; rgb[i * 3 + 1] = lipRgb[1]; rgb[i * 3 + 2] = lipRgb[2];
      } else {
        probs[0 * n + i] = 1;
      }
    }
  }
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, (gx, gy) => {
    const i = (gy * size + gx) * 3;
    return [rgb[i] ?? 0, rgb[i + 1] ?? 0, rgb[i + 2] ?? 0];
  });
  assert.ok(parsed);
  assert.ok(parsed.lip.length >= 32);
  assert.ok(parsed.lip.length <= 80);
  assert.equal(parsed.lip.length, LIP_POINT_COUNT);
  let minX = Infinity, maxX = -Infinity;
  let sx = 0, sy = 0;
  for (const [x, y] of parsed.lip) {
    sx += x; sy += y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const width = maxX - minX;
  assert.ok(longestStraight(parsed.lip) < width * 0.45, "contour has a long straight run");
  const boxCx = box.x + box.w / 2, boxCy = box.y + box.h / 2;
  assert.ok(Math.abs(sx / parsed.lip.length - boxCx) < 0.03);
  assert.ok(Math.abs(sy / parsed.lip.length - boxCy) < 0.03);
  assert.ok(parsed.lipInner);
  assert.ok(parsed.lipInner.length >= 32);
  for (const [x, y] of parsed.lipInner) {
    assert.ok(pointInPoly(x, y, parsed.lip), `inner point ${x},${y} is outside the lip`);
  }
  const want = cieLab(lipRgb[0], lipRgb[1], lipRgb[2]);
  assert.ok(Math.abs(parsed.lipMeanL - want.L) < 0.5, `lipMeanL ${parsed.lipMeanL} vs ${want.L}`);
  assert.ok(Math.abs(parsed.lipMeanA - want.a) < 0.5, `lipMeanA ${parsed.lipMeanA} vs ${want.a}`);
  assert.ok(Math.abs(parsed.lipMeanB - want.b) < 0.5, `lipMeanB ${parsed.lipMeanB} vs ${want.b}`);
  assert.ok(parsed.lipMeanL < cieL(250, 250, 250) - 20);
});

test("a closed mouth omits lipInner, and a mouth blob outside the lip is not used as the hole", () => {
  const size = 96;
  const crop = { x: 100, y: 80, size: 400 };
  const n = size * size;
  const closed = new Float32Array(19 * n);
  const cx = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (inEllipse(x, y, cx, cx, 14, 8)) {
        closed[12 * n + i] = 0.9;
        closed[0 * n + i] = 0.1;
      } else closed[i] = 1;
    }
  }
  const noGap = lipsFromClassProbs(closed, size, crop, 1000, 1250, () => [140, 50, 60]);
  assert.ok(noGap);
  assert.equal(noGap.lipInner, undefined);

  const stray = new Float32Array(closed);
  for (let y = 2; y < 14; y++) {
    for (let x = 2; x < 16; x++) {
      const i = y * size + x;
      stray[11 * n + i] = 0.95;
      stray[12 * n + i] = 0;
      stray[i] = 0;
    }
  }
  const dropped = lipsFromClassProbs(stray, size, crop, 1000, 1250, () => [140, 50, 60]);
  assert.ok(dropped);
  assert.equal(dropped.lipInner, undefined);
});

test("a thin lip contour reaches the field and a skin class stays off the hair", () => {
  const size = 64;
  const box = { x: 0.3, y: 0.2, w: 0.4, h: 0.5 };
  const frameW = 1000, frameH = 1250;
  const crop = squareCropForBox(box, frameW, frameH);
  assert.ok(crop);
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2, cy = cx;
  const lipRx = 16, lipRy = 3;
  const skinRx = 22, skinRy = 26;
  let minFX = size, minFY = size, maxFX = -1, maxFY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (inEllipse(x, y, cx, cy, lipRx, lipRy)) {
        probs[12 * n + i] = 0.7;
        probs[13 * n + i] = 0.25;
        probs[0 * n + i] = 0.05;
        if (x < minFX) minFX = x;
        if (y < minFY) minFY = y;
        if (x > maxFX) maxFX = x;
        if (y > maxFY) maxFY = y;
      } else if (inEllipse(x, y, cx, cy, skinRx, skinRy)) {
        probs[1 * n + i] = 0.92;
        probs[0 * n + i] = 0.08;
      } else {
        probs[14 * n + i] = 0.9;
        probs[0 * n + i] = 0.1;
      }
    }
  }
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, () => [160, 70, 70]);
  assert.ok(parsed);
  const grid = parsed.lip.map(([x, y]) => {
    const px = x * frameW, py = y * frameH;
    return framePxToGrid(px, py, crop, size);
  });
  let minY = Infinity, maxY = -Infinity, minX = Infinity, maxX = -Infinity;
  for (const [x, y] of grid) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  const fieldH = maxFY - minFY + 1;
  const fieldW = maxFX - minFX + 1;
  assert.ok(maxY - minY >= fieldH * 0.85, `contour height ${maxY - minY} vs field ${fieldH}`);
  assert.ok(maxX - minX >= fieldW * 0.85, `contour width ${maxX - minX} vs field ${fieldW}`);
  assert.ok(maxY - minY <= fieldH + 2.5, `contour taller than the field by ${maxY - minY - fieldH}`);
  assert.ok(maxX - minX <= fieldW + 2.5, `contour wider than the field by ${maxX - minX - fieldW}`);
  assert.ok(parsed.skin);
  assert.ok(parsed.skin.length >= 12);
  assert.ok(parsed.skin.length <= 80);
  const hair: [number, number] = [0.02, 0.02];
  assert.equal(pointInPoly(hair[0], hair[1], parsed.skin), false);
  assert.ok(Number.isFinite(parsed.lipMeanL));
  assert.ok(Number.isFinite(parsed.lipMeanA));
  assert.ok(Number.isFinite(parsed.lipMeanB));
});

test("a thin lip traces the soft shoulder outside the hard core", () => {
  const size = 64;
  const crop = { x: 40, y: 40, size: 640 };
  const frameW = 640, frameH = 640;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2, cy = cx;
  let coreMinY = size, coreMaxY = -1, softMinY = size, softMaxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const core = inEllipse(x, y, cx, cy, 14, 2);
      const soft = inEllipse(x, y, cx, cy, 16, 3.6);
      if (core) {
        probs[12 * n + i] = 0.7;
        probs[13 * n + i] = 0.25;
        if (y < coreMinY) coreMinY = y;
        if (y > coreMaxY) coreMaxY = y;
      } else if (soft) {
        // ramp about 0.47: outside the 0.5 core, inside the 0.42 iso
        probs[12 * n + i] = 0.32;
        probs[13 * n + i] = 0.22;
        if (y < softMinY) softMinY = y;
        if (y > softMaxY) softMaxY = y;
      } else {
        probs[i] = 1;
      }
    }
  }
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, () => [160, 70, 70]);
  assert.ok(parsed);
  const grid = parsed.lip.map(([x, y]) => framePxToGrid(x * frameW, y * frameH, crop, size));
  let minY = Infinity, maxY = -Infinity;
  for (const [, y] of grid) {
    if (y < minY) minY = y;
    if (y > maxY) maxY = y;
  }
  const coreH = coreMaxY - coreMinY + 1;
  const softH = Math.max(coreMaxY, softMaxY) - Math.min(coreMinY, softMinY) + 1;
  const span = maxY - minY;
  assert.ok(span >= coreH + 0.5, `contour ${span} should clear the core ${coreH}`);
  assert.ok(span <= softH + 2.5, `contour ${span} past the shoulder field ${softH}`);
});

/** Core plus the cells one and two steps outside it. */
function lipRings(size: number, cx: number, cy: number, rx: number, ry: number): {
  core: Uint8Array;
  ring1: Uint8Array;
  ring2: Uint8Array;
} {
  const n = size * size;
  const core = new Uint8Array(n);
  const ring1 = new Uint8Array(n);
  const ring2 = new Uint8Array(n);
  const touch = (mask: Uint8Array, x: number, y: number): boolean => {
    for (let dy = -1; dy <= 1; dy++) {
      const yy = y + dy;
      if (yy < 0 || yy >= size) continue;
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const xx = x + dx;
        if (xx < 0 || xx >= size) continue;
        if (mask[yy * size + xx]) return true;
      }
    }
    return false;
  };
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (inEllipse(x, y, cx, cy, rx, ry)) core[y * size + x] = 1;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      if (!core[y * size + x] && touch(core, x, y)) ring1[y * size + x] = 1;
    }
  }
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (!core[i] && !ring1[i] && touch(ring1, x, y)) ring2[i] = 1;
    }
  }
  return { core, ring1, ring2 };
}

test("a tiny mouth covers the lower-lip band and the corners", () => {
  const size = 64;
  const crop = { x: 20, y: 20, size: 400 };
  const frameW = 640, frameH = 640;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2, cy = cx;
  const { core, ring1, ring2 } = lipRings(size, cx, cy, 8, 2.2);
  let ring2MaxY = -1, ring2MinX = size, ring2MaxX = -1, coreMaxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lower = y >= cy;
      const corner = x <= cx - 6 || x >= cx + 6;
      if (core[i]) {
        probs[12 * n + i] = 0.72;
        probs[13 * n + i] = 0.24;
        if (y > coreMaxY) coreMaxY = y;
      } else if (ring1[i]) {
        probs[12 * n + i] = 0.34;
        probs[13 * n + i] = 0.202;
      } else if (ring2[i] && (lower || corner)) {
        probs[12 * n + i] = 0.32;
        probs[13 * n + i] = 0.206;
        if (y > ring2MaxY) ring2MaxY = y;
        if (x < ring2MinX) ring2MinX = x;
        if (x > ring2MaxX) ring2MaxX = x;
      } else {
        probs[i] = 1;
      }
    }
  }
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, () => [160, 70, 70]);
  assert.ok(parsed);
  const grid = parsed.lip.map(([x, y]) => framePxToGrid(x * frameW, y * frameH, crop, size));
  let minX = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of grid) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  assert.ok(maxY >= ring2MaxY - 0.25, `bottom ${maxY} short of the lower band ${ring2MaxY}`);
  assert.ok(minX <= ring2MinX + 0.85, `left corner ${minX} inside ${ring2MinX}`);
  assert.ok(maxX >= ring2MaxX - 0.85, `right corner ${maxX} inside ${ring2MaxX}`);
  assert.ok(maxY > coreMaxY + 1, `bottom ${maxY} still on the core ${coreMaxY}`);
  const corner: [number, number] = [ring2MinX + 0.5, cy];
  assert.equal(pointInPoly(corner[0], corner[1], grid), true);
});

test("a wide mouth paints the lower band and the corners and leaves the upper lip on the core", () => {
  const size = 96;
  const crop = { x: 20, y: 20, size: 800 };
  const frameW = 1000, frameH = 1000;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2, cy = cx;
  const { core, ring1, ring2 } = lipRings(size, cx, cy, 20, 10);
  let ring2MaxY = -1, ring2MinX = size, coreMinY = size, coreMaxY = -1, upperTop = size;
  let coreW = 0, coreH = 0;
  let minCX = size, maxCX = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (core[i]) {
        probs[12 * n + i] = 0.72;
        probs[13 * n + i] = 0.24;
        if (y < coreMinY) coreMinY = y;
        if (y > coreMaxY) coreMaxY = y;
        if (x < minCX) minCX = x;
        if (x > maxCX) maxCX = x;
      } else if (ring1[i] || ring2[i]) {
        // ramp 0.45: under the 0.5 iso, over the 0.4 reach floor
        probs[12 * n + i] = 0.33;
        probs[13 * n + i] = 0.20;
        if (y >= cy && y > ring2MaxY) ring2MaxY = y;
        if (ring2[i] && x < ring2MinX) ring2MinX = x;
        if (y < cy && Math.abs(x - cx) <= 4 && y < upperTop) upperTop = y;
      } else {
        probs[i] = 1;
      }
    }
  }
  coreW = maxCX - minCX + 1;
  coreH = coreMaxY - coreMinY + 1;
  assert.ok(Math.min(coreW, coreH) >= 18, `fixture minor ${Math.min(coreW, coreH)} is on the thin path`);
  assert.ok(ring2MaxY > cy, `lower band missing (${ring2MaxY})`);
  assert.ok(upperTop < cy - 1, `upper halo missing (${upperTop})`);
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, () => [160, 70, 70]);
  assert.ok(parsed);
  const grid = parsed.lip.map(([x, y]) => framePxToGrid(x * frameW, y * frameH, crop, size));
  let maxY = -Infinity;
  for (const [, y] of grid) if (y > maxY) maxY = y;
  assert.ok(maxY >= ring2MaxY - 0.9, `bottom ${maxY} short of the lower band ${ring2MaxY}`);
  assert.equal(pointInPoly(ring2MinX + 0.5, cy, grid), true, "left corner is inside the paint");
  assert.equal(pointInPoly(cx, upperTop + 0.5, grid), false, "upper halo was pulled into the paint");
  let topCenter = Infinity;
  for (const [x, y] of grid) {
    if (Math.abs(x - cx) <= 4 && y < topCenter) topCenter = y;
  }
  assert.ok(Number.isFinite(topCenter), "no upper-center vertex");
  assert.ok(topCenter >= coreMinY - 1.2, `upper lip ${topCenter} left the core ${coreMinY}`);
});

test("a thick lip stays on the core when a soft halo sits outside it", () => {
  const size = 96;
  const crop = { x: 10, y: 10, size: 800 };
  const frameW = 1000, frameH = 1000;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2, cy = cx;
  const { core, ring1, ring2 } = lipRings(size, cx, cy, 14, 11);
  let coreMaxY = -1, ring2MaxY = -1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (core[i]) {
        probs[12 * n + i] = 0.72;
        probs[13 * n + i] = 0.24;
        if (y > coreMaxY) coreMaxY = y;
      } else if (ring1[i] || ring2[i]) {
        probs[12 * n + i] = 0.32;
        probs[13 * n + i] = 0.18;
        if (ring2[i] && y > ring2MaxY) ring2MaxY = y;
      } else {
        probs[i] = 1;
      }
    }
  }
  const parsed = lipsFromClassProbs(probs, size, crop, frameW, frameH, () => [160, 70, 70]);
  assert.ok(parsed);
  const grid = parsed.lip.map(([x, y]) => framePxToGrid(x * frameW, y * frameH, crop, size));
  let maxY = -Infinity;
  for (const [, y] of grid) if (y > maxY) maxY = y;
  assert.ok(ring2MaxY >= coreMaxY + 2, `halo ${ring2MaxY} is not outside the core ${coreMaxY}`);
  assert.ok(maxY <= coreMaxY + 1.6, `thick contour ${maxY} grew past the core ${coreMaxY}`);
  assert.ok(maxY < ring2MaxY - 0.5, `thick contour ${maxY} reached the halo ${ring2MaxY}`);
});

test("an implausible speck falls back to the heuristic lip", () => {
  const size = 64;
  const probs = new Float32Array(19 * size * size);
  probs[0] = 1;
  probs[12 * size * size + 10] = 0.99;
  const parsed = lipsFromClassProbs(probs, size, { x: 0, y: 0, size: 1000 }, 1000, 1250, () => [120, 40, 40]);
  assert.equal(parsed, null);
  assert.equal(lipFractionPlausible(1, size * size), false);
  assert.equal(lipFractionPlausible(400, 512 * 512), true);
  const heuristic = {
    lip: [[0.4, 0.7], [0.5, 0.72], [0.6, 0.7]] as [number, number][],
    lipInner: [[0.45, 0.71], [0.5, 0.715], [0.55, 0.71]] as [number, number][],
    lipMeanL: 33,
  };
  const kept = lipsOrHeuristic(heuristic, null);
  assert.equal(kept.lip, heuristic.lip);
  assert.equal(kept.lipInner, heuristic.lipInner);
  assert.equal(kept.lipMeanL, 33);
  const replaced = lipsOrHeuristic(heuristic, {
    lip: [[0.42, 0.68], [0.5, 0.66], [0.58, 0.68], [0.5, 0.74]],
    lipMeanL: 48,
    lipMeanA: 22,
    lipMeanB: 11,
  });
  assert.equal(replaced.lipMeanL, 48);
  assert.equal(replaced.lipMeanA, 22);
  assert.equal(replaced.lipMeanB, 11);
  assert.equal(replaced.lipInner, undefined);
  assert.notEqual(replaced.lip, heuristic.lip);
  const opened = lipsOrHeuristic(heuristic, {
    lip: [[0.42, 0.68], [0.5, 0.66], [0.58, 0.68], [0.5, 0.74]],
    lipInner: [[0.48, 0.70], [0.52, 0.70], [0.50, 0.72]],
    lipMeanL: 48,
    lipMeanA: 22,
    lipMeanB: 11,
  });
  assert.equal(opened.lipInner?.length, 3);
});

test("mean Lab skips the mouth hole and a non-finite sample", () => {
  const w = 80, h = 60;
  const lip: Array<[number, number]> = [[0.2, 0.3], [0.8, 0.3], [0.8, 0.8], [0.2, 0.8]];
  const hole: Array<[number, number]> = [[0.4, 0.48], [0.6, 0.48], [0.6, 0.62], [0.4, 0.62]];
  const flesh: [number, number, number] = [150, 40, 50];
  const want = cieLab(...flesh);
  const mean = meanLipFleshLab(w, h, (x, y) => {
    if (x === 16 && y === 18) return [Number.NaN, 0, 0];
    const nx = x / w, ny = y / h;
    if (pointInPoly(nx, ny, hole)) return [250, 250, 250];
    return flesh;
  }, lip, hole);
  assert.ok(mean !== null);
  assert.ok(Math.abs(mean.L - want.L) < 0.6);
  assert.ok(Math.abs(mean.a - want.a) < 0.6);
  assert.ok(Math.abs(mean.b - want.b) < 0.6);
  assert.ok(mean.L < 70);
  assert.equal(meanLipFleshLab(w, h, () => [Number.NaN, 1, 1], lip, undefined), null);
});

test("a degenerate box or frame does not produce a crop", () => {
  assert.equal(squareCropForBox({ x: 0, y: 0, w: 0, h: 0.4 }, 1000, 1250), null);
  assert.equal(squareCropForBox({ x: Number.NaN, y: 0.1, w: 0.4, h: 0.5 }, 1000, 1250), null);
  assert.equal(squareCropForBox({ x: 0.2, y: 0.1, w: 0.4, h: 0.5 }, 0, 1250), null);
  assert.equal(lipsFromClassProbs(new Float32Array(0), 4, { x: 0, y: 0, size: 10 }, 10, 10, () => [0, 0, 0]), null);
});

test("logits must be [1,19,512,512] and finite", () => {
  const n = 19 * 512 * 512;
  assert.equal(logitsVolumeOk([1, 19, 512, 512], n), true);
  assert.equal(logitsVolumeOk([1, 19, 256, 256], 19 * 256 * 256), false);
  assert.equal(logitsVolumeOk([1, 19, 512, 256], n), false);
  assert.equal(logitsVolumeOk([1, 19, 512], n), false);
  assert.equal(logitsVolumeOk([1, 19, 512, 512], 8), false);
  const ok = copyLogits(new Float32Array([1, 2, 3]), 3);
  assert.ok(ok);
  assert.equal(ok[1], 2);
  assert.equal(copyLogits(new Float32Array([1, Number.NaN, 3]), 3), null);
  assert.equal(copyLogits(new Float32Array([1, Number.POSITIVE_INFINITY]), 2), null);
  assert.equal(copyLogits(new Float32Array([1]), 4), null);
});

test("a lip blob touching the crop edge still closes", () => {
  const size = 96;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (x <= 22 && y >= 34 && y <= 58) {
        probs[12 * n + i] = 0.55;
        probs[13 * n + i] = 0.4;
      } else probs[i] = 1;
    }
  }
  const parsed = lipsFromClassProbs(probs, size, { x: 0, y: 0, size: 960 }, 960, 960, () => [140, 40, 50]);
  assert.ok(parsed);
  assert.equal(parsed.lip.length, LIP_POINT_COUNT);
  let minX = Infinity, maxX = -Infinity;
  for (const [x] of parsed.lip) {
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
  }
  assert.ok(minX < 0.05, `minX ${minX}`);
  assert.ok(maxX < 0.4, `maxX ${maxX}`);
  assert.ok(Number.isFinite(parsed.lipMeanL));
});

test("the lip contour follows the largest component", () => {
  const size = 96;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = 70, cy = 48;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const blob = inEllipse(x, y, cx, cy, 14, 10);
      const speck = x >= 2 && x <= 6 && y >= 2 && y <= 6;
      if (blob || speck) {
        probs[12 * n + i] = 0.92;
        probs[i] = 0.08;
      } else probs[i] = 1;
    }
  }
  const crop = { x: 0, y: 0, size: 960 };
  const parsed = lipsFromClassProbs(probs, size, crop, 960, 960, () => [140, 40, 50]);
  assert.ok(parsed);
  let sx = 0, sy = 0;
  for (const [x, y] of parsed.lip) { sx += x; sy += y; }
  const [ex, ey] = gridToFrameNorm(cx, cy, crop, 960, 960, size);
  assert.ok(Math.abs(sx / parsed.lip.length - ex) < 0.04);
  assert.ok(Math.abs(sy / parsed.lip.length - ey) < 0.04);
});

test("a mouth ring that encloses lip flesh is not the hole", () => {
  const size = 96;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lip = inEllipse(x, y, cx, cx, 18, 12);
      const gap = inEllipse(x, y, cx, cx, 5, 3);
      const ring = inEllipse(x, y, cx, cx, 12, 8) && !gap;
      if (ring) {
        probs[11 * n + i] = 0.92;
        probs[i] = 0.08;
      } else if (lip) {
        probs[12 * n + i] = 0.9;
        probs[i] = 0.1;
      } else probs[i] = 1;
    }
  }
  const parsed = lipsFromClassProbs(probs, size, { x: 100, y: 80, size: 400 }, 1000, 1250, () => [140, 50, 60]);
  assert.ok(parsed);
  assert.equal(parsed.lipInner, undefined);
});

test("a class-11 gap under 4% of the lip area is not a hole", () => {
  assert.equal(LIP_INNER_MIN_FRAC, 0.04);
  const size = 128;
  const n = size * size;
  const probs = new Float32Array(19 * n);
  const cx = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const lip = inEllipse(x, y, cx, cx, 22, 16);
      const gap = inEllipse(x, y, cx, cx, 3, 2);
      if (gap) {
        probs[11 * n + i] = 0.95;
        probs[i] = 0.05;
      } else if (lip) {
        probs[12 * n + i] = 0.9;
        probs[i] = 0.1;
      } else probs[i] = 1;
    }
  }
  const flesh: [number, number, number] = [140, 50, 60];
  const parsed = lipsFromClassProbs(probs, size, { x: 100, y: 80, size: 400 }, 1000, 1250, () => flesh);
  assert.ok(parsed);
  assert.equal(parsed.lipInner, undefined);
  const want = cieLab(...flesh);
  assert.ok(Math.abs(parsed.lipMeanA - want.a) < 0.5);
  assert.ok(Math.abs(parsed.lipMeanB - want.b) < 0.5);
});

test("face and lip runs take the wasm lock one at a time", async () => {
  let active = 0, max = 0;
  const job = () => withOrtLock(async () => {
    active += 1;
    max = Math.max(max, active);
    await new Promise((r) => setTimeout(r, 15));
    active -= 1;
  });
  await Promise.all([job(), job(), job()]);
  assert.equal(max, 1);
});
