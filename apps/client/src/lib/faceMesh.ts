/**
 * MediaPipe Face Landmarker: the 478-point mesh, license-clean geometry.
 *
 * Bedhead's lesson (see ../bedhead): a 478-point mesh beats coarse bands for
 * makeup paint. The lip outline, the mouth hole, the eye rims, and the brow
 * arches come straight from landmark rings - no redness flood, no iso tracing,
 * no WFLW band search. The model is Apache-2.0 (Google MediaPipe), unlike the
 * BiSeNet weights (CelebAMask-HQ, non-commercial); see docs/LICENSE-NOTES.md.
 *
 * Coordinates: MediaPipe returns normalized [0..1] over the SOURCE image. The
 * app's shared geometry is the 4:5 normalized frame (NORMAL_W x NORMAL_H,
 * center-cropped, see face.ts normalizeTo45). We run the landmarker on the
 * already-normalized canvas, so the landmark fractions ARE frame fractions -
 * no remapping needed.
 *
 * Landmark topology (canonical face mesh, mediapipe/python/mediapipe/modules/
 * face_geometry/data/canonical_face_model.obj-contiguous indices):
 *   LIPS_OUTER 61..291 ring (contiguous), LIPS_INNER 78..95 ring (contiguous).
 *   Left eye 33..133 ring, right eye 362..463 ring (contiguous).
 *   Left brow 70..63..105 arc, right brow 336..293..334 arc.
 *   Face oval 10..152 (contiguous) is the skin contour stand-in.
 *
 * Contract (face.ts FaceLandmarks): lip/lipInner/eyeL/eyeR/browL/browR are
 * frame-fraction polygons; lipMeanL/A/B are the mean CIE Lab of the flesh
 * inside the lip ring minus the mouth hole. Irises (468-477) exist in this
 * model but we do not need them. Blendshapes ARE on (IMAGE mode, one shot
 * per capture): the coach expression gate reads jawOpen / mouthSmile off
 * the same detection - see coach/expressionGate.ts.
 */

/** Shared 4:5 frame dimensions (keep in sync with face.ts NORMAL_W/H). */
const NORMAL_W = 1000;
const NORMAL_H = 1250;

/** Box over the face in frame fractions (same shape as face.ts FaceBox). */
interface MeshFaceBox { x: number; y: number; w: number; h: number }

/** Polygon in frame fractions (same shape as face.ts Poly). */
type MeshPoly = ReadonlyArray<readonly [number, number]>;

const MODEL_URL = "models/face_landmarker.task";
/**
 * Canonical rings. These index tuples are copied from bedhead's tracker
 * (478-point mesh, shipped and identity-verified there) - the MediaPipe mesh
 * indices are NOT contiguous ranges, so explicit lists, not start/end.
 */
const OUTER_LIPS = [61, 185, 40, 39, 37, 0, 267, 269, 270, 409, 291, 375, 321, 405, 314, 17, 84, 181, 91, 146] as const;
const INNER_LIPS = [78, 191, 80, 81, 82, 13, 312, 311, 310, 415, 308, 324, 318, 402, 317, 14, 87, 178, 88, 95] as const;
const EYE_L_RING = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246] as const;
const EYE_R_RING = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466] as const;
const BROW_L = [70, 63, 105, 66, 107, 55, 65, 52, 53, 46] as const;
const BROW_R_INDICES = [300, 293, 334, 296, 336, 276, 283, 282, 295, 285] as const;
const FACE_OVAL = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
] as const;

type VisionModule = typeof import("@mediapipe/tasks-vision");

// Coach cascade (face-shape classification for shape-aware contour).
import { measureFace } from "./coach/measure.ts";
import { classifyFace } from "./coach/faceShape.ts";
import { blendScoresFromCategories, type BlendScores } from "./coach/expressionGate.ts";

/**
 * The raw 478 landmark fractions of the LAST successful mesh detection
 * (frame-fraction space). The coach overlay re-runs buildContourMap on
 * these; nothing else reads this. Cleared on failure.
 */
let lastRawPoints: ReadonlyArray<{ x: number; y: number }> | null = null;

/** Raw mesh points from the last detectFaceWithMesh success, if any. */
export function lastMeshPoints(): ReadonlyArray<{ x: number; y: number }> | null {
  return lastRawPoints;
}

/**
 * Blendshape gate scores (jawOpen, mouthSmile) of the LAST successful mesh
 * detection, or null when that detection carried no blendshape output.
 * Same lifetime as lastMeshPoints; the coach expression gate fails open
 * (closed-mouth default) when this is null.
 */
let lastBlendScores: BlendScores | null = null;

/** Blendshape scores from the last detectFaceWithMesh success, if any. */
export function lastBlendshapes(): BlendScores | null {
  return lastBlendScores;
}

let visionPromise: Promise<VisionModule | null> | null = null;

/** Resolve tasks-vision lazily; a missing bundle permanently resolves null. */
export function loadVision(): Promise<VisionModule | null> {
  if (!visionPromise) {
    visionPromise = import("@mediapipe/tasks-vision")
      .then((m) => m as unknown as VisionModule)
      .catch(() => null);
  }
  return visionPromise;
}

type FaceLandmarker = import("@mediapipe/tasks-vision").FaceLandmarker;

let landmarkerPromise: Promise<FaceLandmarker | null> | null = null;

/** One landmarker per page load; any failure resolves null (heuristic path). */
export function loadFaceLandmarker(): Promise<FaceLandmarker | null> {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const vision = await loadVision();
      if (!vision) return null;
      try {
        // Local wasm files (copied from the installed package into public/
        // mediapipe/wasm/) - no CDN dependency, works offline, and the wasm
        // version always matches the JS bundle version.
        const fileset = await vision.FilesetResolver.forVisionTasks("mediapipe/wasm");
        const buf = await fetch(MODEL_URL).then((r) => {
          if (!r.ok) throw new Error(`model fetch ${r.status}`);
          return r.arrayBuffer();
        });
        if (buf.byteLength < 64) return null;
        // The TFLite delegate announcement ("INFO: Created TensorFlow Lite
        // XNNPACK delegate for CPU.") logs at console.error from inside the
        // wasm during session creation. It is informational; silence our own
        // window so the app's console stays clean (probe gate console-clean).
        const origError = console.error;
        console.error = (...args: unknown[]) => {
          if (typeof args[0] === "string" && args[0].startsWith("INFO:")) return;
          origError(...args);
        };
        try {
          return await vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: new Uint8Array(buf) },
            runningMode: "IMAGE",
            numFaces: 1,
            // One IMAGE-mode shot per capture: the scores cost nothing on
            // this path and the coach expression gate fades mouth pigment
            // on open-mouth / big-smile photos (coach/expressionGate.ts).
            // The VIDEO-mode landmarker in liveContour keeps them off.
            outputFaceBlendshapes: true,
            outputFacialTransformationMatrixes: false,
          });
        } finally {
          console.error = origError;
        }
      } catch {
        return null;
      }
    })();
  }
  return landmarkerPromise;
}

/* ---------- landmark -> polygon helpers (pure, unit-testable) ---------- */

export interface MeshPoint {
  x: number;
  y: number;
  z: number;
}

/** Index list -> polygon. MediaPipe rings are explicit index tuples, not ranges. */
export function ring(pts: readonly MeshPoint[], indices: readonly number[]): MeshPoly {
  const out: [number, number][] = [];
  for (const i of indices) {
    const p = pts[i];
    if (!p) continue;
    out.push([p.x, p.y]);
  }
  return out;
}

/**
 * Chaikin corner-cutting on a closed ring: each edge becomes two points at
 * 25%/75%, doubling resolution and interpolating the curve through sparse
 * landmarks without shrinking the ring (the new points lie ON the chords,
 * corners pull inward only where the polygon is convex - the traced flesh).
 */
export function chaikinClosed(poly: MeshPoly, passes = 2): MeshPoly {
  let cur = poly as [number, number][];
  for (let p = 0; p < passes; p++) {
    const out: [number, number][] = [];
    for (let i = 0; i < cur.length; i++) {
      const a = cur[i]!;
      const b = cur[(i + 1) % cur.length]!;
      out.push([0.75 * a[0] + 0.25 * b[0], 0.75 * a[1] + 0.25 * b[1]]);
      out.push([0.25 * a[0] + 0.75 * b[0], 0.25 * a[1] + 0.75 * b[1]]);
    }
    cur = out;
  }
  return cur;
}

export const RING_INDICES = {
  outerLips: OUTER_LIPS,
  innerLips: INNER_LIPS,
  eyeL: EYE_L_RING,
  eyeR: EYE_R_RING,
  browL: BROW_L,
  browR: BROW_R_INDICES,
  faceOval: FACE_OVAL,
} as const;

/** Cheekbone anchor samples (bedhead CHEEK_SAMPLES canonical points). */
export const CHEEK_L_INDEX = 205;
export const CHEEK_R_INDEX = 425;

/**
 * Brow arc note: the right brow's inner->outer walk is the mirror of the
 * left (70<->300, 63<->293, 105<->334, 66<->296, 107<->336); BROW_R_INDICES
 * above is already in inner->outer order, matching BROW_L.
 */

export function browArc(pts: readonly MeshPoint[], indices: readonly number[]): MeshPoly {
  const out: [number, number][] = [];
  for (const i of indices) {
    const p = pts[i];
    if (!p) continue;
    out.push([p.x, p.y]);
  }
  return out;
}

/**
 * Build a closed band around the brow arc: the arc lifted/dropped by a face-
 * scaled offset so the compositor's brow ribbon has height. Purely derived
 * from the arc - no search, no inference.
 */
export function browBand(arc: MeshPoly, thickness: number): MeshPoly {
  if (arc.length < 2) return arc;
  const out: [number, number][] = [];
  for (const [x, y] of arc) out.push([x, y - thickness]);
  for (let i = arc.length - 1; i >= 0; i--) {
    const [x, y] = arc[i]!;
    out.push([x, y + thickness * 0.4]);
  }
  return out;
}

/**
 * Cheek anchor: the canonical cheek point pair 50 (left) / 280 (right),
 * raised onto the cheekbone by the compositor's raiseCheek. We emit small
 * octagons around them so usablePoly (>= 3 finite pts inside the frame) holds.
 */
export function cheekAnchorPoly(pts: readonly MeshPoint[], index: number, rx: number, ry: number): MeshPoly {
  const p = pts[index];
  if (!p) return [];
  const out: [number, number][] = [];
  for (let i = 0; i < 8; i++) {
    const t = (i / 8) * Math.PI * 2;
    out.push([p.x + Math.cos(t) * rx, p.y + Math.sin(t) * ry]);
  }
  return out;
}

/**
 * Face box from the mesh: min/max over the face oval ring, padded so the
 * compositor's faceBox fractions (veil ellipse, contour zones) sit inside.
 */
export function faceBoxFromOval(oval: MeshPoly): MeshFaceBox | null {
  if (oval.length < 3) return null;
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const [x, y] of oval) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const w = maxX - minX;
  const h = maxY - minY;
  if (!(w > 0.01 && h > 0.01)) return null;
  return { x: minX, y: minY, w, h };
}

/* ---------- mean lip color (same contract as face.ts uses for the heuristic lip) ---------- */

const LAB_XN = 0.95047;
const LAB_YN = 1;
const LAB_ZN = 1.08883;

export function cieLab(r: number, g: number, b: number): { L: number; a: number; b: number } {
  const lin = (c: number): number => {
    const s = Math.max(0, Math.min(1, c / 255));
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / LAB_XN;
  const Y = (R * 0.2126729 + G * 0.7151522 + B * 0.0721750) / LAB_YN;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / LAB_ZN;
  const f = (t: number): number => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return { L: 116 * fy - 16, a: 500 * (fx - fy), b: 200 * (fy - fz) };
}

export function pointInPoly(x: number, y: number, poly: MeshPoly): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i]!;
    const pj = poly[j]!;
    if ((pi[1]! > y) === (pj[1]! > y)) continue;
    const xHit = ((pj[0]! - pi[0]!) * (y - pi[1]!)) / (pj[1]! - pi[1]!) + pi[0]!;
    if (x < xHit) inside = !inside;
  }
  return inside;
}

/**
 * Mean CIE Lab over lip flesh: inside the outer ring, outside the inner ring
 * (when the mouth is open), sampled every 2px of the 1000x1250 frame. Null
 * when fewer than 8 samples land (degenerate mesh).
 */
export function meanLipFleshLab(
  rgba: Uint8ClampedArray,
  lip: MeshPoly,
  lipInner: MeshPoly | undefined,
): { L: number; a: number; b: number } | null {
  if (lip.length < 3) return null;
  let minX = 1, minY = 1, maxX = 0, maxY = 0;
  for (const [x, y] of lip) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX * NORMAL_W));
  const y0 = Math.max(0, Math.floor(minY * NORMAL_H));
  const x1 = Math.min(NORMAL_W - 1, Math.ceil(maxX * NORMAL_W));
  const y1 = Math.min(NORMAL_H - 1, Math.ceil(maxY * NORMAL_H));
  const skipHole = lipInner !== undefined && lipInner.length >= 3;
  let sumL = 0, sumA = 0, sumB = 0, n = 0;
  for (let y = y0; y <= y1; y += 2) {
    for (let x = x0; x <= x1; x += 2) {
      const nx = x / NORMAL_W, ny = y / NORMAL_H;
      if (!pointInPoly(nx, ny, lip)) continue;
      if (skipHole && pointInPoly(nx, ny, lipInner!)) continue;
      const i = (y * NORMAL_W + x) * 4;
      const r = rgba[i] ?? 0, g = rgba[i + 1] ?? 0, b = rgba[i + 2] ?? 0;
      if (!Number.isFinite(r) || !Number.isFinite(g) || !Number.isFinite(b)) continue;
      const lab = cieLab(r, g, b);
      sumL += lab.L; sumA += lab.a; sumB += lab.b;
      n += 1;
    }
  }
  if (n < 8) return null;
  const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
  return {
    L: clamp(sumL / n, 0, 100),
    a: clamp(sumA / n, -128, 127),
    b: clamp(sumB / n, -128, 127),
  };
}

/**
 * Run the landmarker on the normalized 4:5 canvas and emit FaceLandmarks
 * (same shape as face.ts detectFace). Null on any failure - the caller keeps
 * the heuristic/biSenet path. Brows are the canonical arcs banded to a
 * ribbon of face-scaled thickness; cheeks are octagons at canonical
 * cheekbone anchors 50/280.
 */
export async function detectFaceWithMesh(canvas: HTMLCanvasElement): Promise<import("./face").FaceLandmarks | null> {
  const landmarker = await loadFaceLandmarker();
  if (!landmarker) return null;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const result = landmarker.detect(canvas);
    const face = result.faceLandmarks?.[0];
    if (!face || face.length < 468) {
      lastBlendScores = null;
      return null;
    }
    const pts: MeshPoint[] = face.map((p) => ({ x: p.x, y: p.y, z: p.z ?? 0 }));
    lastRawPoints = face.map((p) => ({ x: p.x, y: p.y }));
    lastBlendScores = blendScoresFromCategories(result.faceBlendshapes?.[0]?.categories ?? null);

    // The 20-point ring connects sparse landmarks with straight chords; on a
    // curved lip that cuts the flesh at the cupid's bow and corners (measured:
    // ~50% under-fill vs hand traces on small mouths). Two Chaikin passes
    // interpolate the curve the landmarks describe, the same treatment the
    // old parser path gave its contours. Same for the inner ring.
    const lip = chaikinClosed(ring(pts, RING_INDICES.outerLips));
    const lipInner = chaikinClosed(ring(pts, RING_INDICES.innerLips));
    const eyeL = ring(pts, RING_INDICES.eyeL);
    const eyeR = ring(pts, RING_INDICES.eyeR);
    const browLArc = browArc(pts, RING_INDICES.browL);
    const browRArc = browArc(pts, RING_INDICES.browR);
    const oval = browArc(pts, RING_INDICES.faceOval);

    const faceBox = faceBoxFromOval(oval);
    if (!faceBox) return null;

    // Face-scaled band thickness for the brows: ~1.4% of box height.
    const browThickness = faceBox.h * 0.014;
    const browL = browBand(browLArc, browThickness);
    const browR = browBand(browRArc, browThickness);

    // Cheek anchors (canonical cheekbone points), octagons at ~9% box width.
    const crx = faceBox.w * 0.09;
    const cry = faceBox.h * 0.06;
    const cheekL = cheekAnchorPoly(pts, CHEEK_L_INDEX, crx, cry);
    const cheekR = cheekAnchorPoly(pts, CHEEK_R_INDEX, crx, cry);
    if (cheekL.length < 3 || cheekR.length < 3) return null;

    // Mean lip flesh color from the actual pixels under the ring.
    const rgba = ctx.getImageData(0, 0, NORMAL_W, NORMAL_H).data;
    const hasHole = lipInner.length >= 3;
    const mean = meanLipFleshLab(rgba, lip, hasHole ? lipInner : undefined);

    // Coach cascade: classify the face for shape-aware contour placement.
    // measureFace's yaw gate returns null for non-frontal captures, and the
    // cascade's own default is oval/low-confidence - never a hard failure.
    let faceShape: string | undefined;
    try {
      const m = measureFace(pts);
      if (m) faceShape = classifyFace(m).primary;
    } catch {
      faceShape = undefined;
    }

    return {
      faceBox,
      lip,
      ...(hasHole ? { lipInner: lipInner as unknown as import("./face").Poly } : {}),
      ...(mean
        ? { lipMeanL: mean.L, lipMeanA: mean.a, lipMeanB: mean.b }
        : {}),
      skin: oval,
      eyeL,
      eyeR,
      browL,
      browR,
      cheekL,
      cheekR,
      ...(faceShape ? { faceShape } : {}),
    };
  } catch {
    lastBlendScores = null;
    return null;
  }
}
