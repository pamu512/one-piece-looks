import test from "node:test";
import assert from "node:assert/strict";
import {
  gradeZone,
  deltaMetric,
  gridInPoly,
  ringAroundPoly,
  placementHint,
  type RGB,
  type Pt,
} from "./applicationGrade.ts";

const square: Pt[] = [{ x: 0.4, y: 0.4 }, { x: 0.6, y: 0.4 }, { x: 0.6, y: 0.6 }, { x: 0.4, y: 0.6 }];

test("gridInPoly samples inside only", () => {
  const pts = gridInPoly(square, 8);
  assert.ok(pts.length >= 4);
  for (const p of pts) {
    assert.ok(p.x >= 0.4 && p.x <= 0.6 && p.y >= 0.4 && p.y <= 0.6);
  }
});

test("ringAroundPoly sits outside the zone", () => {
  const ring = ringAroundPoly(square, 8, 0.05);
  assert.ok(ring.length > 0);
  for (const p of ring) {
    const outside = p.x < 0.4 - 0.001 || p.x > 0.6 + 0.001 || p.y < 0.4 - 0.001 || p.y > 0.6 + 0.001;
    assert.ok(outside, `ring point inside: ${JSON.stringify(p)}`);
  }
});

test("deltaMetric signs per kind", () => {
  const before: RGB = [150, 120, 110];
  // blush: redder
  assert.ok(deltaMetric("blush", before, [190, 118, 108]) > 0);
  // contour: darker
  assert.ok(deltaMetric("contour", before, [110, 90, 85]) > 0);
  // contour: brighter is NOT product
  assert.ok(deltaMetric("contour", before, [200, 170, 160]) < 0);
  // highlight: brighter
  assert.ok(deltaMetric("highlight", before, [220, 195, 180]) > 0);
});

const flat = (n: number, c: RGB): RGB[] => Array.from({ length: n }, () => c);

test("gradeZone: empty skin waits; full -> that's it", () => {
  const inside = gridInPoly(square, 8);
  const ring = ringAroundPoly(square, 8, 0.05);
  const skin: RGB = [150, 120, 110];
  // nothing applied
  const none = gradeZone({ kind: "blush", poly: square, baselineInside: flat(inside.length, skin), currentInside: flat(inside.length, skin), baselineRing: flat(ring.length, skin), currentRing: flat(ring.length, skin) });
  assert.equal(none.feedback, "Watch the path, then paint along it");
  assert.equal(none.coverage, 0);
  // fully applied blush inside, clean ring
  const blushC: RGB = [200, 110, 110];
  const full = gradeZone({ kind: "blush", poly: square, baselineInside: flat(inside.length, skin), currentInside: flat(inside.length, blushC), baselineRing: flat(ring.length, skin), currentRing: flat(ring.length, skin) });
  assert.equal(full.coverage, 1);
  assert.ok(full.score > 0.8, `score ${full.score}`);
  assert.match(full.feedback, /that's it/);
});

test("gradeZone: paint outside an empty zone still waits", () => {
  const inside = gridInPoly(square, 8);
  const ring = ringAroundPoly(square, 8, 0.05);
  const skin: RGB = [150, 120, 110];
  const blushC: RGB = [205, 105, 105];
  const g = gradeZone({
    kind: "blush",
    poly: square,
    baselineInside: flat(inside.length, skin),
    currentInside: flat(inside.length, skin),
    baselineRing: flat(ring.length, skin),
    currentRing: flat(ring.length, blushC),
  });
  assert.equal(g.coverage, 0);
  assert.ok(g.overflow > 0.5, `overflow ${g.overflow}`);
  assert.equal(g.feedback, "Watch the path, then paint along it");
});

test("gradeZone: a thin coat is still not yet", () => {
  const poly: Pt[] = [
    { x: 0.15, y: 0.15 },
    { x: 0.85, y: 0.15 },
    { x: 0.85, y: 0.85 },
    { x: 0.15, y: 0.85 },
  ];
  const inside = gridInPoly(poly);
  const ring = ringAroundPoly(poly);
  const skin: RGB = [150, 120, 110];
  const blushC: RGB = [200, 110, 110];
  assert.ok(inside.length >= 8, `need enough samples, got ${inside.length}`);
  const current = flat(inside.length, skin);
  current[0] = blushC;
  const g = gradeZone({
    kind: "blush",
    poly,
    baselineInside: flat(inside.length, skin),
    currentInside: current,
    baselineRing: flat(ring.length, skin),
    currentRing: flat(ring.length, skin),
  });
  assert.ok(g.coverage > 0 && g.coverage < 0.2, `coverage ${g.coverage}`);
  assert.match(g.feedback, /not yet/);
});

test("gradeZone: overflow detected", () => {
  const inside = gridInPoly(square, 8);
  const ring = ringAroundPoly(square, 8, 0.05);
  const skin: RGB = [150, 120, 110];
  const blushC: RGB = [205, 105, 105];
  const g = gradeZone({ kind: "blush", poly: square, baselineInside: flat(inside.length, skin), currentInside: flat(inside.length, blushC), baselineRing: flat(ring.length, skin), currentRing: flat(ring.length, blushC) });
  assert.ok(g.overflow > 0.3, `overflow ${g.overflow}`);
  assert.match(g.feedback, /lighter hand/);
});

test("gradeZone: placement hint from centroid offset", () => {
  const inside = gridInPoly(square, 8);
  const ring = ringAroundPoly(square, 8, 0.05);
  const skin: RGB = [150, 120, 110];
  const blushC: RGB = [205, 105, 105];
  // apply only on the TOP half of samples (lower y)
  const current = inside.map((p) => (p.y < 0.5 ? blushC : skin) as RGB);
  const g = gradeZone({ kind: "blush", poly: square, baselineInside: flat(inside.length, skin), currentInside: current, baselineRing: flat(ring.length, skin), currentRing: flat(ring.length, skin) });
  // product centroid above zone center -> "a touch lower" is where MORE should go
  assert.ok(g.offset.y < 0, `offset y ${g.offset.y}`);
  assert.match(g.feedback, /a touch lower/); // partial application still directs
});

test("placementHint directions (hint names where to ADD)", () => {
  assert.match(placementHint({ x: 0, y: -0.03 }), /lower/);   // product high -> add lower
  assert.match(placementHint({ x: 0, y: 0.03 }), /higher/);   // product low -> add higher
  assert.match(placementHint({ x: 0.03, y: 0 }), /further in/);   // product too far out
  assert.match(placementHint({ x: -0.03, y: 0 }), /further out/); // product too far in
  assert.equal(placementHint({ x: 0, y: 0 }), "");
});
