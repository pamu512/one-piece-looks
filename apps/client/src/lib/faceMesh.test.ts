/**
 * Unit tests for the MediaPipe mesh geometry (lib/faceMesh.ts) - the pure
 * functions only; the landmarker itself needs the wasm bundle (browser).
 *
 * Covers: index-tuple ring extraction, the closed inner-lip ring, brow arc
 * + band, cheek octagon, face-box derivation, point-in-poly, and the mean
 * lip flesh Lab sampler against a synthetic frame.
 */
import assert from "node:assert/strict";
import test from "node:test";

import {
  CHEEK_L_INDEX, CHEEK_R_INDEX, RING_INDICES, browArc, browBand, cheekAnchorPoly,
  cieLab, faceBoxFromOval, meanLipFleshLab, pointInPoly, ring,
  type MeshPoint,
} from "./faceMesh.ts";

/** Synthetic mesh: 478 points on a plausible face (lips ~y0.7, eyes ~y0.4). */
function syntheticMesh(): MeshPoint[] {
  const pts: MeshPoint[] = [];
  const at = (i: number, x: number, y: number) => { pts[i] = { x: x / 1000, y: y / 1250, z: 0 }; };
  // Fill every index with something stable first.
  for (let i = 0; i < 478; i++) at(i, 500 + i, 600);

  // Outer lips: ellipse cx500 cy875 rx110 ry55 over the 20 ring indices.
  const outer = RING_INDICES.outerLips;
  outer.forEach((idx, k) => {
    const t = (k / outer.length) * Math.PI * 2;
    at(idx, 500 + Math.cos(t) * 110, 875 + Math.sin(t) * 55);
  });

  // Inner lips: a smaller ellipse (the mouth hole), same ordering as the ring.
  const inner = RING_INDICES.innerLips;
  inner.forEach((idx, k) => {
    const t = (k / inner.length) * Math.PI * 2;
    at(idx, 500 + Math.cos(t) * 78, 875 + Math.sin(t) * 22);
  });

  // Eyes: left ring cx330 cy500, right cx670, rx50 ry22.
  RING_INDICES.eyeL.forEach((idx, k) => {
    const t = (k / RING_INDICES.eyeL.length) * Math.PI * 2;
    at(idx, 330 + Math.cos(t) * 50, 500 + Math.sin(t) * 22);
  });
  RING_INDICES.eyeR.forEach((idx, k) => {
    const t = (k / RING_INDICES.eyeR.length) * Math.PI * 2;
    at(idx, 670 + Math.cos(t) * 50, 500 + Math.sin(t) * 22);
  });

  // Brows: arcs above the eyes, sinusoidal arch.
  const browArcY = (k: number, n: number) => 430 - Math.sin((k / (n - 1)) * Math.PI) * 12;
  RING_INDICES.browL.forEach((idx, k) => at(idx, 290 + k * 14, browArcY(k, RING_INDICES.browL.length)));
  RING_INDICES.browR.forEach((idx, k) => at(idx, 710 - k * 14, browArcY(k, RING_INDICES.browR.length)));

  // Face oval: large ellipse cx500 cy640 rx330 ry430.
  const oval = RING_INDICES.faceOval;
  oval.forEach((idx, k) => {
    const t = (k / oval.length) * Math.PI * 2;
    at(idx, 500 + Math.cos(t) * 330, 640 + Math.sin(t) * 430);
  });

  // Cheek anchors.
  at(CHEEK_L_INDEX, 320, 640);
  at(CHEEK_R_INDEX, 680, 640);
  return pts;
}

test("outer lip ring follows the index tuple with sane bounds", () => {
  const pts = syntheticMesh();
  const lip = ring(pts, RING_INDICES.outerLips);
  assert.equal(lip.length, RING_INDICES.outerLips.length);
  for (const [x, y] of lip) {
    assert.ok(x >= 0 && x <= 1 && y >= 0 && y <= 1, "fractions in frame");
  }
  const ys = lip.map(([, y]) => y * 1250);
  assert.ok(Math.min(...ys) > 790 && Math.max(...ys) < 960, `lip ring stays in the mouth band (${Math.min(...ys).toFixed(0)}..${Math.max(...ys).toFixed(0)})`);
});

test("inner lip ring is closed and strictly inside the outer ring", () => {
  const pts = syntheticMesh();
  const inner = ring(pts, RING_INDICES.innerLips);
  const outer = ring(pts, RING_INDICES.outerLips);
  assert.equal(inner.length, RING_INDICES.innerLips.length);
  // First and last: the tuple starts and ends at the mouth corners (78, 95),
  // so the polygon is closed by connecting the last point to the first.
  const [x0, y0] = inner[0]!;
  const [xn, yn] = inner[inner.length - 1]!;
  assert.ok(Math.abs(x0 - xn) < 0.02, `corners share x: ${x0} vs ${xn}`);
  // Every inner point is inside the outer polygon and its area is smaller.
  let innerInside = 0;
  for (const [x, y] of inner) if (pointInPoly(x, y, outer)) innerInside += 1;
  assert.equal(innerInside, inner.length, "hole ring strictly inside the outer ring");
  const area = (poly: ReadonlyArray<readonly [number, number]>) => {
    let a = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      a += poly[j]![0]! * poly[i]![1]! - poly[i]![0]! * poly[j]![1]!;
    }
    return Math.abs(a) / 2;
  };
  assert.ok(area(inner) < area(outer), "mouth hole is smaller than the lip");
});

test("brow arc + band produce a closed ribbon above the eye", () => {
  const pts = syntheticMesh();
  const arc = browArc(pts, RING_INDICES.browR);
  assert.equal(arc.length, RING_INDICES.browR.length);
  const band = browBand(arc, 0.014);
  assert.equal(band.length, arc.length * 2);
  const ys = band.map(([, y]) => y);
  const arcMinY = Math.min(...arc.map(([, y]) => y));
  const arcMaxY = Math.max(...arc.map(([, y]) => y));
  assert.ok(Math.min(...ys) < arcMinY, "band reaches above the arc");
  assert.ok(Math.max(...ys) > arcMaxY, "band reaches below the arc");
});

test("cheek anchor is an octagon around the canonical point", () => {
  const pts = syntheticMesh();
  const cheek = cheekAnchorPoly(pts, CHEEK_L_INDEX, 0.09, 0.06);
  assert.equal(cheek.length, 8);
  const xs = cheek.map(([x]) => x);
  assert.ok(Math.max(...xs) - Math.min(...xs) > 0.1, "octagon spans the face-scaled width");
});

test("face box derives from the oval and keeps a plausible portrait shape", () => {
  const pts = syntheticMesh();
  const oval = browArc(pts, RING_INDICES.faceOval);
  const box = faceBoxFromOval(oval);
  assert.ok(box);
  const ar = box!.h / box!.w;
  assert.ok(ar > 0.9 && ar < 2.4, `aspect ${ar.toFixed(2)} is portrait-plausible`);
  assert.ok(faceBoxFromOval([[0.5, 0.5], [0.5, 0.5]]) === null, "degenerate oval rejected");
});

test("pointInPoly and cieLab agree with the shared helpers", () => {
  const square: Array<[number, number]> = [[0, 0], [1, 0], [1, 1], [0, 1]];
  assert.equal(pointInPoly(0.5, 0.5, square), true);
  assert.equal(pointInPoly(1.5, 0.5, square), false);
  // Pure red in Lab is L~53, a~80, b~68 (D65).
  const lab = cieLab(255, 0, 0);
  assert.ok(Math.abs(lab.L - 53.2) < 1.5 && Math.abs(lab.a - 80.1) < 3 && Math.abs(lab.b - 67.2) < 4,
    `red Lab ${lab.L.toFixed(1)},${lab.a.toFixed(1)},${lab.b.toFixed(1)}`);
});

test("meanLipFleshLab samples inside the outer ring, outside the hole", () => {
  const pts = syntheticMesh();
  const lip = ring(pts, RING_INDICES.outerLips);
  const hole = ring(pts, RING_INDICES.innerLips);
  // Paint the frame: skin tone everywhere, lips a distinct red band.
  const W = 1000, H = 1250;
  const rgba = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 4;
      const inLip = pointInPoly(x / W, y / H, lip);
      const inHole = pointInPoly(x / W, y / H, hole);
      if (inLip && !inHole) {
        rgba[i] = 179; rgba[i + 1] = 18; rgba[i + 2] = 46; rgba[i + 3] = 255; // #b3122e
      } else {
        rgba[i] = 194; rgba[i + 1] = 142; rgba[i + 2] = 107; rgba[i + 3] = 255; // skin
      }
    }
  }
  const withHole = meanLipFleshLab(rgba, lip, hole);
  assert.ok(withHole, "mean computed");
  // Mean should be close to the lock red but pulled by antialias-free mixing.
  assert.ok(withHole!.a > 40, `a* ${withHole!.a.toFixed(1)} reads red, not skin`);
  const withoutHole = meanLipFleshLab(rgba, lip, undefined)!;
  // Hole pixels are skin-colored here, so including them shifts a* down.
  assert.ok(withoutHole.a < withHole.a, "hole exclusion keeps the mean redder");
});
