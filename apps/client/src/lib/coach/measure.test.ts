/**
 * Tests for coach/measure.ts - synthetic landmark faces only (the landmarker
 * itself is browser wasm; these test the pure math).
 */
import assert from "node:assert/strict";
import test from "node:test";

import { measureFace, normalizeFace, YAW_GATE, type CoachPoint, type FaceMeasurements } from "./measure.ts";

/** A canonical frontal face: indices -> (x, y) in 4:5 fractions. */
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
  // pad the rest of the 478 mesh with stable filler
  for (let i = 0; i < 478; i++) if (!pts[i]) pts[i] = { x: 0.5, y: 0.5, z: 0 };
  return pts;
}

function rollBy(face: CoachPoint[], deg: number): CoachPoint[] {
  const a = (deg * Math.PI) / 180;
  const cos = Math.cos(a), sin = Math.sin(a);
  return face.map((p) => ({ x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos, z: p.z }));
}

function yawBy(face: CoachPoint[], frac: number): CoachPoint[] {
  // shear the upper face horizontally toward +x by frac of ear distance
  const dx = frac * Math.hypot(face[454]!.x - face[234]!.x, face[454]!.y - face[234]!.y);
  return face.map((p, i) => (i <= 10 ? p : { ...p, x: p.x + dx }));
}

test("normalized measurements on the canonical face land in balanced/oval territory", () => {
  const m = measureFace(canonicalFrontal());
  assert.ok(m, "frontal face measures");
  assert.ok(m.FLPR > 1.15 && m.FLPR < 1.6, `FLPR ${m.FLPR.toFixed(3)} in the oval band`);
  assert.ok(m.JBR > 0.7 && m.JBR < 0.95, `JBR ${m.JBR.toFixed(3)} plausible`);
  assert.ok(m.jawAng > 60 && m.jawAng < 180, `jawAng ${m.jawAng.toFixed(1)} deg sane`);
  assert.ok(m.chinAng > 60, `chinAng ${m.chinAng.toFixed(1)} deg sane`);
});

test("measurements are invariant to roll and uniform scale", () => {
  const base = measureFace(canonicalFrontal())!;
  const rolled = measureFace(rollBy(canonicalFrontal(), 9))!;
  const tiny = canonicalFrontal().map((p) => ({ x: p.x * 0.31, y: p.y * 0.31, z: p.z }));
  const scaled = measureFace(tiny)!;
  for (const key of ["FLPR", "JBR", "FBR", "HWR", "jawAng", "chinAng"] as const) {
    assert.ok(Math.abs(base[key] - rolled[key]) < 1e-6, `${key} roll-invariant`);
    assert.ok(Math.abs(base[key] - scaled[key]) < 1e-6, `${key} scale-invariant`);
  }
});

test("FL, CW, JW, FW, MW match direct landmark distances (IOD units)", () => {
  const face = canonicalFrontal();
  const m = measureFace(face)!;
  const norm = normalizeFace(face)!;
  const d = (a: number, b: number) => {
    const pa = norm.points.get(a)!, pb = norm.points.get(b)!;
    return Math.hypot(pa.x - pb.x, pa.y - pb.y);
  };
  assert.ok(Math.abs(m.FL - d(10, 152)) < 1e-9);
  assert.ok(Math.abs(m.CW - d(127, 356)) < 1e-9);
  assert.ok(Math.abs(m.JW - d(172, 397)) < 1e-9);
  assert.ok(Math.abs(m.FW - d(103, 332)) < 1e-9);
  assert.ok(Math.abs(m.MW - d(61, 291)) < 1e-9);
  assert.ok(Math.abs(m.HWR - m.FW / m.CW) < 1e-9, "HWR is FW/CW");
});

test("HWR grows when the temples move out and the cheeks stay put", () => {
  const base = measureFace(canonicalFrontal())!;
  const wider = canonicalFrontal();
  wider[103] = { x: 0.22, y: wider[103]!.y, z: 0 };
  wider[332] = { x: 0.78, y: wider[332]!.y, z: 0 };
  const moved = measureFace(wider)!;
  assert.ok(moved.HWR > base.HWR, `wider hairline ${moved.HWR.toFixed(3)} > ${base.HWR.toFixed(3)}`);
  assert.ok(Math.abs(moved.CW - base.CW) < 1e-9, "cheek width unchanged");
});

test("yaw gate: past 6% of face width the face is refused (null)", () => {
  const face = canonicalFrontal();
  assert.ok(measureFace(face), "frontal passes");
  const turned = yawBy(face, YAW_GATE + 0.02);
  const m = measureFace(turned);
  assert.equal(m, null, "3/4 face refused");
});

test("yaw proxy grows monotonically with shear and the gate sits at 6%", () => {
  const face = canonicalFrontal();
  const y0 = normalizeFace(face)!.yawOffset;
  const y1 = normalizeFace(yawBy(face, 0.04))!.yawOffset;
  const y2 = normalizeFace(yawBy(face, 0.12))!.yawOffset;
  assert.ok(y0 < y1 && y1 < y2, `yaw proxy monotonic: ${y0.toFixed(3)} < ${y1.toFixed(3)} < ${y2.toFixed(3)}`);
  assert.ok(y1 <= YAW_GATE, "small yaw inside the gate");
  assert.ok(y2 > YAW_GATE, "big yaw outside the gate");
});

test("a zero width that would divide HWR or FBR is refused", () => {
  const cheeks = canonicalFrontal();
  cheeks[356] = { x: cheeks[127]!.x, y: cheeks[127]!.y, z: 0 };
  assert.equal(measureFace(cheeks), null);
  const jaw = canonicalFrontal();
  jaw[397] = { x: jaw[172]!.x, y: jaw[172]!.y, z: 0 };
  assert.equal(measureFace(jaw), null);
});

test("non-finite landmarks and overflowed coordinates are refused", () => {
  for (const x of [Number.NaN, Number.POSITIVE_INFINITY]) {
    const face = canonicalFrontal();
    face[10] = { x, y: 0.12, z: 0 };
    assert.equal(measureFace(face), null);
  }
  const huge = canonicalFrontal();
  huge[10] = { x: 1e308, y: 1e308, z: 0 };
  huge[152] = { x: -1e308, y: -1e308, z: 0 };
  assert.equal(measureFace(huge), null);
});

test("degenerate inputs are refused, not thrown", () => {
  assert.equal(measureFace([]), null);
  const two: CoachPoint[] = [{ x: 0.1, y: 0.1 }, { x: 0.2, y: 0.2 }];
  assert.equal(measureFace(two), null);
  // coincident eyes -> zero IOD
  const flat = canonicalFrontal().map((p) => ({ ...p }));
  flat[33] = { x: 0.5, y: 0.4, z: 0 };
  flat[263] = { x: 0.5, y: 0.4, z: 0 };
  assert.equal(measureFace(flat), null);
});

test("chin angle responds to chin pointedness", () => {
  const face = canonicalFrontal();
  const base = measureFace(face)!;
  // pull the chin down to a point -> sharper (smaller) angle at 152
  const pointed = face.map((p, i) => (i === 152 ? { x: 0.5, y: 0.95, z: 0 } : p));
  const m2 = measureFace(pointed)!;
  assert.ok(m2.chinAng < base.chinAng, `pointed chin ${m2.chinAng.toFixed(1)} < rounder ${base.chinAng.toFixed(1)}`);
});
