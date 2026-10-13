import test from "node:test";
import assert from "node:assert/strict";
import {
  createSweepCollector,
  invertRigid,
  applyMat,
  poseAngles,
  sweepMarks,
  sweepProgress,
  SWEEP_DONE_LINE,
  SWEEP_FUSED_LINE,
  type Mat4,
} from "./faceSweep.ts";

/** Column-major rigid transform from yaw (deg about Y) + pitch (deg about X). */
function rigid(yawDeg: number, pitchDeg: number): Mat4 {
  const y = (yawDeg * Math.PI) / 180;
  const p = (pitchDeg * Math.PI) / 180;
  const cy = Math.cos(y), sy = Math.sin(y);
  const cp = Math.cos(p), sp = Math.sin(p);
  // R = Rx(p) * Ry(y)
  const R = [
    cy, 0, sy,
    sp * sy, cp, -sp * cy,
    -cp * sy, sp, cp * cy,
  ];
  const m = new Float32Array(16);
  // column-major: m[c*4+r] = R[r][c]
  for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) m[c * 4 + r] = R[r * 3 + c]!;
  m[12] = 0; m[13] = 0; m[14] = -1; // head 1 unit in front of camera
  m[15] = 1;
  return m;
}

/** A small canonical-ish cloud: nose forward, ears back, chin low. */
function fakeLandmarks() {
  const pts = [];
  for (let i = 0; i < 478; i++) pts.push({ x: (i % 40) / 100 - 0.2, y: Math.floor(i / 40) / 20 - 0.1, z: 0 });
  pts[4] = { x: 0, y: 0, z: -0.15 };       // nose tip forward
  pts[234] = { x: -0.18, y: 0, z: 0.1 };   // ear L back
  pts[454] = { x: 0.18, y: 0, z: 0.1 };    // ear R back
  pts[33] = { x: -0.06, y: -0.02, z: -0.05 };
  pts[263] = { x: 0.06, y: -0.02, z: -0.05 };
  pts[152] = { x: 0, y: 0.12, z: -0.02 };  // chin
  pts[172] = { x: -0.14, y: 0.09, z: 0.02 };
  pts[397] = { x: 0.14, y: 0.09, z: 0.02 };
  return pts;
}

test("rigid inverse round-trips", () => {
  for (const [yaw, pitch] of [[0, 0], [25, 0], [-30, 10], [0, 18], [12, -8]]) {
    const m = rigid(yaw, pitch);
    const inv = invertRigid(m);
    const p = { x: 0.03, y: -0.02, z: -0.12 };
    const round = applyMat(inv, applyMat(m, p));
    assert.ok(Math.abs(round.x - p.x) < 1e-5, `yaw ${yaw} pitch ${pitch}: x ${round.x}`);
    assert.ok(Math.abs(round.y - p.y) < 1e-5, `yaw ${yaw} pitch ${pitch}: y ${round.y}`);
    assert.ok(Math.abs(round.z - p.z) < 1e-5, `yaw ${yaw} pitch ${pitch}: z ${round.z}`);
  }
});

test("poseAngles reads back yaw/pitch", () => {
  const a = poseAngles(rigid(30, 0));
  assert.ok(Math.abs(a.yawDeg - 30) < 0.5, `yaw ${a.yawDeg}`);
  const b = poseAngles(rigid(0, 15));
  assert.ok(Math.abs(b.pitchDeg - 15) < 0.5, `pitch ${b.pitchDeg}`);
});

test("collector accepts distinct views, rejects duplicates", () => {
  const c = createSweepCollector();
  const pts = fakeLandmarks();
  // 5 views: center, left 25, right 25, up 15, and a near-duplicate of center
  const views: [number, number][] = [[0, 0], [25, 0], [-25, 0], [0, 15], [1, 1]];
  for (const [yaw, pitch] of views) {
    const st = c.feed(pts, rigid(yaw, pitch));
    assert.equal(st.phase, "collecting");
  }
  const st = c.state;
  assert.equal(st.viewCount, 4, `near-duplicate rejected; got ${st.viewCount}`);
  assert.equal(st.covered.left && st.covered.right && st.covered.up && st.covered.center, true);
});

test("fused model lands in canonical head frame with measured depth", () => {
  const c = createSweepCollector();
  const pts = fakeLandmarks();
  // The SAME physical points observed from three rotations: inverse-
  // transforming camera-space observations must recover head-local coords.
  for (const [yaw, pitch] of [[0, 0], [25, 0], [-25, 0], [0, 15], [0, -12], [12, 6]]) {
    // camera-space observation = Rigid * headLocal
    const cam = pts.map((p) => applyMat(rigid(yaw, pitch), p));
    c.feed(cam, rigid(yaw, pitch));
  }
  const sweep = c.finish();
  assert.ok(sweep, "sweep produced");
  assert.equal(sweep!.viewCount, 6);
  // median-fused nose tip should recover head-local z ≈ -0.15
  const nose = sweep!.points[4]!;
  assert.ok(Math.abs(nose.z - (-0.15)) < 1e-4, `nose z ${nose.z}`);
  const ear = sweep!.points[234]!;
  assert.ok(Math.abs(ear.z - 0.1) < 1e-4, `ear z ${ear.z}`);
  // frontal reference computed from the most frontal view
  assert.ok(sweep!.frontal && sweep!.frontal.iod > 0, "frontal iod present");
});

test("finish with too few views returns null", () => {
  const c = createSweepCollector();
  const pts = fakeLandmarks();
  c.feed(pts, rigid(0, 0));
  assert.equal(c.finish(), null);
});

test("five sweep marks follow covered flags; copy keeps the four-view rule", () => {
  assert.equal(SWEEP_DONE_LINE, "Done needs four distinct views");
  assert.equal(SWEEP_FUSED_LINE, "The fused model keeps your zones steady after you turn.");
  const none = sweepMarks();
  assert.deepEqual(none.map((m) => m.id), ["left", "right", "up", "down", "front"]);
  assert.deepEqual(none.map((m) => m.on), [false, false, false, false, false]);

  const pts = fakeLandmarks();
  const oneEach: Array<[number, number, number]> = [
    [25, 0, 0],
    [-25, 0, 1],
    [0, 15, 2],
    [0, -15, 3],
    [0, 0, 4],
  ];
  for (const [yaw, pitch, idx] of oneEach) {
    const col = createSweepCollector();
    col.feed(pts, rigid(yaw, pitch));
    const marks = sweepMarks(col.state.covered);
    assert.equal(marks.length, 5);
    marks.forEach((m, i) => assert.equal(m.on, i === idx, `${m.id} at yaw ${yaw} pitch ${pitch}`));
    assert.equal(col.finish(), null);
  }

  const col = createSweepCollector();
  const live = col.feed(pts, rigid(0, 0));
  const held = sweepProgress(null, live);
  assert.notEqual(held, live);
  assert.equal(sweepProgress(held, live), held);
  assert.equal(held.viewCount, 1);
  assert.deepEqual(held.covered, { left: false, right: false, up: false, down: false, center: true });
  col.feed(pts, rigid(25, 0));
  assert.equal(live.viewCount, 2);
  assert.equal(live.covered.left, true);
  assert.equal(held.viewCount, 1, "held copy must not follow later feed()");
  assert.equal(held.covered.left, false);
  const moved = sweepProgress(held, live);
  assert.equal(moved.viewCount, 2);
  assert.deepEqual(moved.covered, { left: true, right: false, up: false, down: false, center: true });
  assert.notEqual(moved, held);
  assert.equal(sweepProgress(moved, live), moved);
  assert.equal(col.finish(), null);
});
