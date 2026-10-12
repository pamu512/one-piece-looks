/**
 * Face sweep accumulator: turn the head (left/right/up/down) once, get a
 * personal 3D model of the face.
 *
 * The mesh we already run returns 478 landmarks WITH estimated z per frame,
 * plus (once outputFacialTransformationMatrixes is on) a 4x4 head-pose
 * matrix per frame. A sweep gives many viewpoints of the same face:
 *
 *   collect  -> per frame: pose matrix + landmarks, gated by detection
 *               confidence and pose separation (we want distinct views)
 *   project  -> landmarks are in head-local space ALREADY when read with
 *               the inverse pose; MediaPipe's transform maps head -> camera,
 *               so inverse-transform puts every frame in one canonical
 *               head frame
 *   fuse     -> robust per-landmark average (median) across accepted views:
 *               a landmark only well-seen from some views is still placed,
 *               occluded guesses get outvoted
 *
 * Result: FaceSweep { points: 478 x {x,y,z} head-local, viewCount }. The
 * z-depth is now a MEASURED multi-view consensus, not a per-frame guess.
 *
 * Everything runs on-device; no frames leave the phone. A sweep is ~10s.
 */

export interface SweepPoint {
  x: number;
  y: number;
  z: number;
}

export interface FaceSweep {
  /** Median-fused landmarks in the canonical head frame (roughly metric-ish
   *  units scaled like MediaPipe z: fraction of frame width at head size 1). */
  points: SweepPoint[];
  /** How many distinct views were fused. */
  viewCount: number;
  /** Best frontal-ish view seen during the sweep (for 2D fallbacks). */
  frontal?: { rollDeg: number; iod: number };
  t: number;
}

/** Minimal 4x4 row-major matrix ops (MediaPipe returns column-major 16). */
export type Mat4 = Float32Array; // length 16, COLUMN-major (MediaPipe convention)

export function invertRigid(m: Mat4): Mat4 {
  // For a rigid transform [R | t; 0 1], inverse = [R^T | -R^T t].
  // Column-major: m[c*4+r].
  const out = new Float32Array(16);
  // R^T
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      out[c * 4 + r] = m[r * 4 + c] ?? 0;
    }
  }
  // -R^T t. In column-major out, ROW r of R^T sits at out[r], out[r+4],
  // out[r+8] (R^T row r = R column r).
  const tx = m[12] ?? 0, ty = m[13] ?? 0, tz = m[14] ?? 0;
  out[12] = -(out[0]! * tx + out[4]! * ty + out[8]! * tz);
  out[13] = -(out[1]! * tx + out[5]! * ty + out[9]! * tz);
  out[14] = -(out[2]! * tx + out[6]! * ty + out[10]! * tz);
  out[15] = 1;
  return out;
}

export function applyMat(m: Mat4, p: { x: number; y: number; z: number }): SweepPoint {
  return {
    x: (m[0] ?? 0) * p.x + (m[4] ?? 0) * p.y + (m[8] ?? 0) * p.z + (m[12] ?? 0),
    y: (m[1] ?? 0) * p.x + (m[5] ?? 0) * p.y + (m[9] ?? 0) * p.z + (m[13] ?? 0),
    z: (m[2] ?? 0) * p.x + (m[6] ?? 0) * p.y + (m[10] ?? 0) * p.z + (m[14] ?? 0),
  };
}

/** Head yaw/pitch (deg) from the rotation part — for view gating. */
export function poseAngles(m: Mat4): { yawDeg: number; pitchDeg: number } {
  // With column-major m, the third column is where the head +z axis maps.
  // yaw = rotation about Y, pitch = about X (approximation, fine for gating).
  const zx = m[8] ?? 0, zy = m[9] ?? 0, zz = m[10] ?? 1;
  const yawDeg = Math.atan2(zx, zz) * (180 / Math.PI);
  const pitchDeg = Math.atan2(-zy, Math.hypot(zx, zz)) * (180 / Math.PI);
  return { yawDeg, pitchDeg };
}

export interface SweepState {
  phase: "idle" | "collecting" | "done";
  viewCount: number;
  /** Coverage hint for the UI: which directions are still needed. */
  covered: { left: boolean; right: boolean; up: boolean; down: boolean; center: boolean };
}

/**
 * Create a sweep collector. Call feed() every frame with the landmarker
 * result. finish() returns the fused model. The collector keeps at most
 * `maxViews` views spaced by >= minYawGap degrees (or pitch for up/down).
 */
export function createSweepCollector(maxViews = 48, minYawGap = 6) {
  const accepted: { yaw: number; pitch: number; pts: Array<{ x: number; y: number; z: number }> }[] = [];
  const state: SweepState = {
    phase: "idle",
    viewCount: 0,
    covered: { left: false, right: false, up: false, down: false, center: false },
  };

  const feed = (
    landmarks: Array<{ x: number; y: number; z: number }> | undefined,
    matrix: Mat4 | undefined,
  ): SweepState => {
    if (!landmarks || landmarks.length < 468 || !matrix) return state;
    state.phase = "collecting";
    const { yawDeg, pitchDeg } = poseAngles(matrix);
    // Distinct-view gate: accept if no accepted view within minYawGap on
    // BOTH yaw and pitch (one may match when the other differs).
    const novel = accepted.every(
      (v) => Math.abs(v.yaw - yawDeg) >= minYawGap || Math.abs(v.pitch - pitchDeg) >= minYawGap / 2,
    );
    if (novel && accepted.length < maxViews) {
      const inv = invertRigid(matrix);
      const pts = landmarks.map((p) => applyMat(inv, p));
      accepted.push({ yaw: yawDeg, pitch: pitchDeg, pts });
      state.viewCount = accepted.length;
      if (yawDeg > 18) state.covered.left = true;
      if (yawDeg < -18) state.covered.right = true;
      if (pitchDeg > 12) state.covered.up = true;
      if (pitchDeg < -12) state.covered.down = true;
      if (Math.abs(yawDeg) < 8 && Math.abs(pitchDeg) < 8) state.covered.center = true;
    }
    return state;
  };

  const finish = (): FaceSweep | null => {
    if (accepted.length < 4) { state.phase = "idle"; return null; }
    state.phase = "done";
    const n = accepted[0]!.pts.length;
    const pts: SweepPoint[] = [];
    for (let i = 0; i < n; i++) {
      const xs: number[] = [];
      const ys: number[] = [];
      const zs: number[] = [];
      for (const v of accepted) {
        const p = v.pts[i]!;
        xs.push(p.x); ys.push(p.y); zs.push(p.z);
      }
      const med = (arr: number[]) => {
        arr.sort((a, b) => a - b);
        const mid = arr.length >> 1;
        return arr.length % 2 ? arr[mid]! : (arr[mid - 1]! + arr[mid]!) / 2;
      };
      pts.push({ x: med(xs), y: med(ys), z: med(zs) });
    }
    // Frontal reference: interocular distance + roll in the most frontal view
    const frontalView = accepted.reduce((best, v) =>
      Math.abs(v.yaw) + Math.abs(v.pitch) < Math.abs(best.yaw) + Math.abs(best.pitch) ? v : best,
    );
    const eL = frontalView.pts[33]!;
    const eR = frontalView.pts[263]!;
    const iod = Math.hypot(eR.x - eL.x, eR.y - eL.y);
    const rollDeg = (Math.atan2(eR.y - eL.y, eR.x - eL.x) * 180) / Math.PI;
    return { points: pts, viewCount: accepted.length, frontal: { rollDeg, iod }, t: Date.now() };
  };

  return { feed, finish, state };
}

/* ---------- 3D measurements from the fused model ---------- */

import { classifyFace, FACE_SHAPES } from "./coach/faceShape.ts";
import { measureFace } from "./coach/measure.ts";

/**
 * Classify from the FUSED 3D model: project the head-local points into a
 * frontal 2D plane (drop z) — which is exactly a frontal, roll-free,
 * yaw-free view of her face — then run the existing cascade. The fused
 * model also yields depth measures the 2D cascade cannot see:
 *
 *   cheekProm: cheekbone forward protrusion vs the ear line (3D only)
 *   jawDepth:  chin forward vs jaw corners (3D only)
 *
 * Returns the classification plus the 3D extras for display/calibration.
 */
export function classifyFromSweep(sweep: FaceSweep): {
  primary: string;
  secondary: string;
  confidence: number;
  cheekProm: number;
  jawDepth: number;
} | null {
  const pts = sweep.points;
  if (pts.length < 468) return null;
  const frontal2D = pts.map((p) => ({ x: p.x, y: p.y }));
  const m = measureFace(frontal2D);
  if (!m) return null;
  const cls = classifyFace(m);
  // 3D-only extras (medians make these stable):
  const prom = (a: number, b: number, ear: number) =>
    ((pts[a]!.z + pts[b]!.z) / 2 - pts[ear]!.z); // negative = forward
  const cheekProm = -(prom(116, 345, 234) + prom(116, 345, 454)) / 2;
  const jawDepth = -(pts[152]!.z - (pts[172]!.z + pts[397]!.z) / 2);
  return {
    primary: cls.primary,
    secondary: cls.secondary,
    confidence: cls.confidence,
    cheekProm: +cheekProm.toFixed(4),
    jawDepth: +jawDepth.toFixed(4),
  };
}
