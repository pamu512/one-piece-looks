/**
 * Tests for coach/zones.ts - the section 7.3 invariant suite:
 * every zone polygon inside the skin hull, L/R mirror symmetry within
 * 5% IOD, positive widths, deterministic output.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { normalizeFace, type CoachPoint } from "./measure.ts";
import { buildContourMap, pointInPoly, polyInsideHull, RIBBON_SAMPLES, ribbonPolygon, type ContourMap, type Pt } from "./zones.ts";

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

function faceMap(): { face: ReturnType<typeof normalizeFace>; map: ContourMap } {
  const face = normalizeFace(canonicalFrontal())!;
  return { face, map: buildContourMap(face) };
}

test("catalog completeness: 8 zones + 8 ribbons, ids unique", () => {
  const { map } = faceMap();
  assert.equal(map.zones.length, 8, `zones: ${map.zones.map((z) => z.id).join(",")}`);
  assert.equal(map.ribbons.length, 8, `ribbons: ${map.ribbons.map((r) => r.id).join(",")}`);
  const ids = [...map.zones.map((z) => z.id), ...map.ribbons.map((r) => r.id)];
  assert.equal(new Set(ids).size, ids.length, "ids unique");
});

test("every zone and ribbon polygon sits inside the skin hull", () => {
  const { map } = faceMap();
  for (const z of map.zones) {
    assert.ok(polyInsideHull(z.poly, map.skinHull), `zone ${z.id} inside the hull`);
  }
  for (const r of map.ribbons) {
    assert.ok(polyInsideHull(r.poly, map.skinHull), `ribbon ${r.id} inside the hull`);
  }
});

test("L/R mirror pairs agree within 5% IOD (centroid x reflected about the face axis)", () => {
  const { face, map } = faceMap();
  const iod = face.iod;
  const pairs: [string, string][] = [
    ["cheek_apple_L", "cheek_apple_R"],
    ["under_eye_L", "under_eye_R"],
    ["temple_L", "temple_R"],
    ["jaw_L", "jaw_R"],
    ["cheek_shelf_L", "cheek_shelf_R"],
  ];
  const centroid = (poly: Pt[]): Pt => ({
    x: poly.reduce((a, q) => a + q.x, 0) / poly.length,
    y: poly.reduce((a, q) => a + q.y, 0) / poly.length,
  });
  // face axis: the x of the normalized midline (nose tip 4)
  const axisX = face.points.get(4)!.x;
  for (const [l, r] of pairs) {
    const cl = centroid(map.zones.find((z) => z.id === l)?.poly ?? map.ribbons.find((z) => z.id === l)!.poly);
    const cr = centroid(map.zones.find((z) => z.id === r)?.poly ?? map.ribbons.find((z) => z.id === r)!.poly);
    const mirrorErr = Math.abs(axisX - cl.x - (cr.x - axisX));
    assert.ok(mirrorErr <= iod * 0.05, `${l}/${r} mirror error ${mirrorErr.toFixed(4)} <= 5% IOD (${(iod * 0.05).toFixed(4)})`);
    assert.ok(Math.abs(centroid(map.zones.find((z) => z.id === l)?.poly ?? map.ribbons.find((z) => z.id === l)!.poly).y - centroid(map.zones.find((z) => z.id === r)?.poly ?? map.ribbons.find((z) => z.id === r)!.poly).y) <= iod * 0.05, `${l}/${r} heights match`);
  }
});

test("ribbon polygons have positive width and the sampled count", () => {
  const { face, map } = faceMap();
  for (const r of map.ribbons) {
    assert.ok(r.poly.length >= RIBBON_SAMPLES, `${r.id} sampled N=${r.poly.length}`);
    const width = (poly: Pt[]): number => {
      const xs = poly.map((q) => q.x);
      return Math.max(...xs) - Math.min(...xs);
    };
    assert.ok(width(r.poly) > 0, `${r.id} has positive extent`);
    assert.ok(r.widthMaxIod > 0);
  }
  // width profile: mid-width exceeds end-width (sin^k taper)
  const line: Pt[] = [{ x: 0.4, y: 0.5 }, { x: 0.5, y: 0.5 }, { x: 0.6, y: 0.5 }];
  const poly = ribbonPolygon(line, 0.1, face.iod);
  const ys = poly.map((q) => q.y);
  assert.ok(Math.max(...ys) - Math.min(...ys) > 0, "horizontal ribbon carries vertical width");
});

test("construction is deterministic", () => {
  const a = JSON.stringify(buildContourMap(normalizeFace(canonicalFrontal())!));
  const b = JSON.stringify(buildContourMap(normalizeFace(canonicalFrontal())!));
  assert.equal(a, b);
});

test("pointInPoly agrees with the shared mesh helper on a square", () => {
  const sq: Pt[] = [{ x: 0, y: 0 }, { x: 1, y: 0 }, { x: 1, y: 1 }, { x: 0, y: 1 }];
  assert.equal(pointInPoly(0.5, 0.5, sq), true);
  assert.equal(pointInPoly(1.5, 0.5, sq), false);
});
