/**
 * Live contour: the real-time "where to apply" overlay.
 *
 * The pivot (2026-10-11): stop compositing finished looks; instead draw the
 * cited contour placements ON THE LIVE CAMERA FEED, so she sees where each
 * product goes on her own moving face.
 *
 * Geometry: zones.ts works on any fractional CoachPoint array, and
 * MediaPipe VIDEO-mode returns fractions of the VIDEO frame — so the
 * polygons can be drawn straight into a transparent canvas layered over
 * the <video> element, no normalize/45-crop involved at all.
 *
 * Classification: the coach cascade (measure + faceShape) runs on the
 * latest frame at ~1 Hz (it is cheap; the mesh itself runs every frame).
 * The published label changes only after three identical samples, so a
 * borderline still cannot flicker oval ↔ pear. A tracking gap clears
 * that run. A turned head keeps the last shape and paints only the
 * near-side ribbons.
 */

import { loadVision } from "./faceMesh.ts";
import { measureFace } from "./coach/measure.ts";
import { classifyFace, FACE_SHAPES, type FaceShape } from "./coach/faceShape.ts";
import {
  buildContourMap,
  CHEEK_EAR_INDEX,
  CHEEK_HOLLOW_INDEX,
  type ContourMap,
  type Ribbon,
  type RibbonId,
} from "./coach/zones.ts";
import type { CoachPoint } from "./coach/measure.ts";
import { rules } from "./coach/plan.ts";
import { createSweepCollector, classifyFromSweep, type FaceSweep, type SweepState } from "./faceSweep.ts";
import { gradeZone, gridInPoly, ringAroundPoly, type RGB, type StepKind, type GradeSample } from "./applicationGrade.ts";

type FaceLandmarker = import("@mediapipe/tasks-vision").FaceLandmarker;
type Pt2 = { x: number; y: number };

let videoLandmarkerPromise: Promise<FaceLandmarker | null> | null = null;

/** Separate VIDEO-mode landmarker (MediaPipe cannot switch modes per instance). */
export function loadVideoLandmarker(modelUrl: string): Promise<FaceLandmarker | null> {
  if (!videoLandmarkerPromise) {
    videoLandmarkerPromise = (async () => {
      const vision = await loadVision();
      if (!vision) return null;
      try {
        const buf = await (await fetch(modelUrl)).arrayBuffer();
        const origError = console.error;
        console.error = () => {};
        try {
          const fileset = await vision.FilesetResolver.forVisionTasks("mediapipe/wasm");
          return await vision.FaceLandmarker.createFromOptions(fileset, {
            baseOptions: { modelAssetBuffer: new Uint8Array(buf) },
            runningMode: "VIDEO",
            numFaces: 1,
            outputFaceBlendshapes: false,
            outputFacialTransformationMatrixes: true,
          });
        } finally {
          console.error = origError;
        }
      } catch {
        return null;
      }
    })();
  }
  return videoLandmarkerPromise;
}

/**
 * The ribbon ids a shape's chart rule lights. Labels are the canonical
 * nine-label chart (rules.json schema 4, all shapes first-class).
 */
export function contourRibbonsForShape(shape: string): RibbonId[] {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  return (rules.shapes[key]?.contour?.ribbons ?? []) as RibbonId[];
}

/** The blush motion spec for a shape (path anchors / orbit / V). */
export function blushMotionForShape(shape: string): (BlushMotion & { zone?: string; angle?: number }) | null {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  const b = rules.shapes[key]?.blush;
  if (!b) return null;
  return { kind: (b as Record<string, unknown>).kind as string | undefined, from: (b as Record<string, unknown>).from as string | undefined, to: (b as Record<string, unknown>).to as string | undefined, center: (b as Record<string, unknown>).center as string | undefined, guide: (b as Record<string, unknown>).guide as string | undefined, note: (b as Record<string, unknown>).note as string | undefined, pressure: (b as Record<string, unknown>).pressure as string | undefined, zone: b.zone, angle: b.angle_deg };
}

/** The highlight zones a shape's chart rule lights. */
export function highlightZonesForShape(shape: string): string[] {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  return rules.shapes[key]?.highlight?.zones ?? [];
}

export type CoachLayer = "contour" | "blush" | "highlight";

/* ---------- guided lesson: one stroke at a time, in MUA order ---------- */

export interface LessonStep {
  layer: CoachLayer;
  /** Card title, e.g. "Shade · temples". */
  title: string;
  /** The instruction she follows, from the cited chart data. */
  instruction: string;
  /** Product/tool line (wikiHow technique guidance, see comment). */
  tool: string;
  ribbonIds?: string[];
  zoneBaseIds?: string[];
}

const RIBBON_NAME: Record<string, string> = {
  temple_L: "temples", temple_R: "temples",
  jaw_L: "jawline", jaw_R: "jawline",
  cheek_shelf_L: "under the cheekbones", cheek_shelf_R: "under the cheekbones",
  cheek_tip_L: "the cheekbone tips", cheek_tip_R: "the cheekbone tips",
  under_chin: "under the chin", hairline_top: "the hairline",
};

const TOOL_LINES = {
  // Technique lines from the wikiHow MUA guides: powder blush = fluffy brush,
  // sweeping back-and-forth, never circular; cream = fingertip, tap to blend;
  // highlighter = small dabs, layers build; contour = angled brush, light hand.
  contour: "Contour shade on an angled brush - light hand, blend as you go.",
  blush: "Fluffy brush for powder (sweep, never circle) or a fingertip tap for cream.",
  highlight: "A small brush or fingertip - little dabs, build up in layers.",
};

const cap = (x: string) => x.charAt(0).toUpperCase() + x.slice(1);

export type TeachRole = "anchor" | "lift" | "statement";

/**
 * Guided lesson for the look she was holding.
 * Anchor is shade, Lift adds blush, Statement is the full order
 * (shade, then blush, then light). A shape with none of those steps
 * falls back to the full lesson so Teach never opens blank.
 */
export function lessonForRole(shape: string, role: TeachRole): LessonStep[] {
  const all = buildLesson(shape);
  const want: CoachLayer[] =
    role === "anchor" ? ["contour"] :
    role === "lift" ? ["contour", "blush"] :
    ["contour", "blush", "highlight"];
  const picked = all.filter((s) => want.includes(s.layer));
  return picked.length > 0 ? picked : all;
}

export type FocusGuideAction = "wait" | "keep" | "open";

/**
 * Whether a role handoff should open its lesson.
 * Stop and Done wait. Past the first step, a new shape keeps the lesson
 * she already started. The same shape at step 0 does not reopen it.
 */
export function focusGuideAction(input: {
  focusRole: TeachRole | null;
  stopped: boolean;
  shape: string | null | undefined;
  guideIdx: number | null;
  openedShape: string | null;
}): FocusGuideAction {
  if (!input.focusRole || input.stopped || !input.shape) return "wait";
  if (input.guideIdx !== null && input.guideIdx > 0) return "keep";
  if (input.openedShape === input.shape && input.guideIdx === 0) return "keep";
  return "open";
}

/** The ordered lesson for a shape: each shade region, then blush, then light. */
export function buildLesson(shape: string): LessonStep[] {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  const spec = rules.shapes[key];
  const steps: LessonStep[] = [];
  const ribbons = (spec?.contour?.ribbons ?? []) as string[];
  const seen = new Set<string>();
  for (const id of ribbons) {
    const base = id.replace(/_(L|R)$/, "");
    if (seen.has(base)) continue;
    seen.add(base);
    const dir = rules.brushDirections[id];
    steps.push({
      layer: "contour",
      title: `Shade · ${RIBBON_NAME[id] ?? base}`,
      instruction: dir ? `${cap(dir)}.` : "Follow the moving shade.",
      tool: TOOL_LINES.contour,
      ribbonIds: ribbons.filter((r) => r.replace(/_(L|R)$/, "") === base),
    });
  }
  const blush = spec?.blush as Record<string, unknown> | undefined;
  if (blush?.note) {
    steps.push({
      layer: "blush",
      title: "Blush · the cheeks",
      instruction: cap(String(blush.note)).replace(/\.$/, "") + ".",
      tool: TOOL_LINES.blush,
    });
  }
  const hi = (spec?.highlight?.zones ?? []) as string[];
  if (hi.length) {
    steps.push({
      layer: "highlight",
      title: "Light · the high points",
      instruction: "Tap the light where the glow lands - it blooms in order.",
      tool: TOOL_LINES.highlight,
      zoneBaseIds: hi,
    });
  }
  return steps;
}

/** Consecutive samples of one label that is not the published shape yet. */
export interface ShapeStreak {
  pending: string;
  count: number;
}

export function freshShapeStreak(): ShapeStreak {
  return { pending: "", count: 0 };
}

/** Identical 1s readings required before a new face shape is published. */
export const SHAPE_HOLD_SAMPLES = 3;

/**
 * Publish `candidate` only after SHAPE_HOLD_SAMPLES identical readings
 * that differ from `prev`. A reading of `prev`, or a different label,
 * starts the count over. `null` or `""` is a missed sample (no mesh
 * measure): it does not vote and does not clear a run. Does not mutate
 * `streak`.
 */
export function holdShape(
  prev: string,
  candidate: string | null,
  streak: ShapeStreak,
): { shape: string; streak: ShapeStreak } {
  if (candidate == null || candidate === "") return { shape: prev, streak };
  if (candidate === prev) {
    if (streak.count === 0 && streak.pending === "") return { shape: prev, streak };
    return { shape: prev, streak: freshShapeStreak() };
  }
  const count = streak.pending === candidate && Number.isInteger(streak.count) && streak.count > 0
    ? streak.count + 1
    : 1;
  if (count >= SHAPE_HOLD_SAMPLES) {
    return { shape: candidate, streak: freshShapeStreak() };
  }
  return { shape: prev, streak: { pending: candidate, count } };
}

/**
 * Zero the hold when the mesh appears or disappears.
 * A stable presence keeps the same streak object.
 */
export function syncShapeStreak(
  streak: ShapeStreak,
  facePresent: boolean,
  seen: boolean,
): { streak: ShapeStreak; facePresent: boolean } {
  if (seen === facePresent) return { streak, facePresent };
  return { streak: freshShapeStreak(), facePresent: seen };
}

/** Teaching grey. Product color stays off this layer. */
export const TEACHING_GREY: [number, number, number] = [180, 184, 192];

/** Faint full path under the brush. Alpha and radius stay under the stroke. */
export const GHOST_ALPHA = 0.04;
export const GHOST_RADIUS = 0.028;
export const GHOST_SAMPLES = 12;

/** Moving brush. The head is the brightest sample and never passes the cap. */
export const STROKE_ALPHA = 0.22;
export const STROKE_RADIUS = 0.04;
export const STROKE_HEAD_CAP = 0.5;
export const STROKE_SAMPLES = 22;

/** |yaw| under this paints both sides. */
export const YAW_FRONTAL_DEG = 10;

/** |yaw| at or above this hides every ribbon (near profile on the faceYawDeg scale). */
export const YAW_RIBBON_MAX_DEG = 48;

/** Hollow cap, as a fraction of the ear-to-hollow span. Yawed frames also require the centroid past that span and the start off the ear. */
export const CHEEK_HOLLOW_MAX_SPAN = 0.65;
export const CHEEK_EAR_MIN_SPAN = 1;
export const CHEEK_START_EAR_MIN_SPAN = 0.25;

/** Guided brush reaches the end here, then holds through the rest of the 3200ms cycle. */
const GUIDE_REACH = 0.8;

const NEAR_SLACK = 0.02;

/**
 * Ribbon ids to paint. A locked lesson list is returned unchanged so a
 * later shape publish cannot drop a stroke. Null follows the live shape.
 */
export function paintRibbonIds(liveShape: string, guideIds: readonly string[] | null): readonly string[] {
  if (guideIds != null) return guideIds;
  return contourRibbonsForShape(liveShape);
}

/** Brush head in [0, 1]. Unguided wraps the cycle; guided reaches 1 at 0.8 and holds. */
export function brushProgress(cycleT: number, phase: number, guided: boolean): number {
  const sum = (Number.isFinite(cycleT) ? cycleT : 0) + (Number.isFinite(phase) ? phase : 0);
  let wrapped = sum % 1;
  if (wrapped < 0) wrapped += 1;
  if (!guided) return wrapped;
  return wrapped >= GUIDE_REACH ? 1 : wrapped / GUIDE_REACH;
}

/**
 * Per-sample stroke alpha. Samples past the head are 0. The head is the
 * max of the painted prefix, capped at STROKE_HEAD_CAP.
 */
export function strokeAlphas(n: number, progress: number): number[] {
  if (!Number.isFinite(n) || n <= 0) return [];
  const count = Math.floor(n);
  const out = new Array<number>(count).fill(0);
  const p = Number.isFinite(progress) ? Math.min(1, Math.max(0, progress)) : 0;
  const head = Math.ceil(p * count) - 1;
  if (head < 0) return out;
  const last = Math.min(count - 1, head);
  for (let i = 0; i <= last; i++) {
    const lead = last === 0 ? 1 : i / last;
    out[i] = Math.min(STROKE_HEAD_CAP, STROKE_ALPHA * (0.4 + 0.6 * lead));
  }
  return out;
}

/** Nose-vs-ear yaw in degrees. A missing landmark or non-finite coordinate returns 0. */
export function faceYawDeg(
  nose: { x: number; y: number } | null | undefined,
  earL: { x: number; y: number } | null | undefined,
  earR: { x: number; y: number } | null | undefined,
): number {
  if (!nose || !earL || !earR) return 0;
  const coords = [nose.x, nose.y, earL.x, earL.y, earR.x, earR.y];
  if (coords.some((v) => !Number.isFinite(v))) return 0;
  const span = Math.hypot(earR.x - earL.x, earR.y - earL.y);
  if (!(span > 0)) return 0;
  return ((nose.x - (earL.x + earR.x) / 2) / span) * 60;
}

/**
 * Whole-ribbon occlusion. Frontal keeps both sides. At or past the profile
 * cutoff nothing paints. Otherwise the centroid must sit on the near side.
 */
export function ribbonVisible(
  centroid: { x: number; y: number } | null | undefined,
  yawDeg: number,
  noseX: number,
): boolean {
  if (!centroid || !Number.isFinite(centroid.x) || !Number.isFinite(centroid.y)) return false;
  if (!Number.isFinite(yawDeg)) return true;
  if (Math.abs(yawDeg) >= YAW_RIBBON_MAX_DEG) return false;
  if (Math.abs(yawDeg) < YAW_FRONTAL_DEG) return true;
  if (!Number.isFinite(noseX)) return false;
  const yawSign = yawDeg < 0 ? 1 : -1;
  return yawSign * (centroid.x - noseX) >= -NEAR_SLACK;
}

export interface CheekPlacement {
  id: "cheek_shelf_L" | "cheek_shelf_R";
  visible: boolean;
  centroid: { x: number; y: number } | null;
  lineStart: { x: number; y: number } | null;
  hollow: { x: number; y: number } | null;
  ear: { x: number; y: number } | null;
  hollowDist: number | null;
  earDist: number | null;
  startEarDist: number | null;
  span: number | null;
}

export interface ContourFrameProbe {
  yawDeg: number;
  noseX: number;
  cheeks: CheekPlacement[];
  /** Landmark fractions the prove uses to see where the shelf actually sits. */
  marks: Record<string, { x: number; y: number } | null>;
}

function finitePt(p: { x: number; y: number } | undefined): { x: number; y: number } | null {
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
  return { x: p.x, y: p.y };
}

/** Cheek-shelf centroid against the hollow midpoint and the ear anchor, in landmark fractions. */
export function cheekRibbonPlacement(
  ribbons: readonly { id: string; centerline?: readonly { x: number; y: number }[] }[],
  points: ReadonlyMap<number, { x: number; y: number }>,
  yawDeg: number,
  noseX: number,
): CheekPlacement[] {
  const ids = ["cheek_shelf_L", "cheek_shelf_R"] as const;
  return ids.map((id) => {
    const line = ribbons.find((r) => r.id === id)?.centerline;
    const centroid = line && line.length > 0 ? lineCentroid(line) : null;
    const lineStart = line && line.length > 0 ? { x: line[0]!.x, y: line[0]!.y } : null;
    const [h0, h1] = CHEEK_HOLLOW_INDEX[id];
    const a = finitePt(points.get(h0));
    const b = finitePt(points.get(h1));
    const hollow = a && b ? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } : null;
    const ear = finitePt(points.get(CHEEK_EAR_INDEX[id]));
    const hollowDist = centroid && hollow ? Math.hypot(centroid.x - hollow.x, centroid.y - hollow.y) : null;
    const earDist = centroid && ear ? Math.hypot(centroid.x - ear.x, centroid.y - ear.y) : null;
    const startEarDist = lineStart && ear ? Math.hypot(lineStart.x - ear.x, lineStart.y - ear.y) : null;
    const span = hollow && ear ? Math.hypot(hollow.x - ear.x, hollow.y - ear.y) : null;
    const visible = !!(line && line.length >= 2 && centroid && ribbonVisible(centroid, yawDeg, noseX));
    return { id, visible, centroid, lineStart, hollow, ear, hollowDist, earDist, startEarDist, span };
  });
}

/** Null when a visible shelf is on the hollow. Ear floor applies only when `yawed` is set. */
export function cheekPlacementFault(p: CheekPlacement, yawed: boolean): string | null {
  if (!p.visible) return null;
  if (p.hollowDist == null || p.span == null || !(p.span > 1e-4)) return `${p.id} missing hollow reference`;
  const hollowCap = CHEEK_HOLLOW_MAX_SPAN * p.span;
  if (!(p.hollowDist < hollowCap)) {
    return `${p.id} hollowDist ${p.hollowDist.toFixed(4)} >= ${hollowCap.toFixed(4)}`;
  }
  if (!yawed) return null;
  const earFloor = CHEEK_EAR_MIN_SPAN * p.span;
  if (p.earDist == null || !(p.earDist > earFloor)) {
    return `${p.id} earDist ${p.earDist == null ? "none" : p.earDist.toFixed(4)} <= ${earFloor.toFixed(4)}`;
  }
  const startFloor = CHEEK_START_EAR_MIN_SPAN * p.span;
  if (p.startEarDist == null || !(p.startEarDist > startFloor)) {
    return `${p.id} startEarDist ${p.startEarDist == null ? "none" : p.startEarDist.toFixed(4)} <= ${startFloor.toFixed(4)}`;
  }
  return null;
}

function publishContourProbe(probe: ContourFrameProbe | null): void {
  const host = globalThis as {
    __oplContourFrame?: ContourFrameProbe | null;
    __oplCheekPlacementFault?: typeof cheekPlacementFault;
  };
  host.__oplContourFrame = probe;
  host.__oplCheekPlacementFault = cheekPlacementFault;
}

function samplePath(
  line: readonly { x: number; y: number }[],
  steps: number,
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  if (steps < 2 || line.length === 0) return out;
  const last = line.length - 1;
  for (let k = 0; k < steps; k++) {
    const f = (k / (steps - 1)) * last;
    const i0 = Math.floor(f);
    const i1 = Math.min(last, i0 + 1);
    const u = f - i0;
    const a = line[i0];
    const b = line[i1];
    if (!a || !b) continue;
    out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
  }
  return out;
}

function lineCentroid(line: readonly { x: number; y: number }[]): { x: number; y: number } | null {
  if (line.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const p of line) {
    sx += p.x;
    sy += p.y;
  }
  return { x: sx / line.length, y: sy / line.length };
}

function paintPuff(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: readonly [number, number, number],
  a: number,
): void {
  if (!(r > 0) || !(a > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
  const g = ctx.createRadialGradient(x, y, 0, x, y, r);
  const [cr, cg, cb] = color;
  g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
  g.addColorStop(0.6, `rgba(${cr},${cg},${cb},${(a * 0.45).toFixed(3)})`);
  g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
}

/** Contour teaching layer. Mesh centerlines stay live; only the id list is locked. */
export function paintContourLayer(
  ctx: CanvasRenderingContext2D,
  frame: {
    width: number;
    height: number;
    ribbons: readonly Ribbon[];
    liveShape: string;
    guideIds: readonly string[] | null;
    yawDeg: number;
    noseX: number;
    cycleT: number;
    guided: boolean;
  },
): void {
  const { width: W, height: H } = frame;
  if (!(W > 0) || !(H > 0)) return;
  const ids = paintRibbonIds(frame.liveShape, frame.guideIds);
  for (const [idx, id] of ids.entries()) {
    const line = frame.ribbons.find((r) => r.id === id)?.centerline;
    if (!line || line.length < 2) continue;
    const centroid = lineCentroid(line);
    if (!centroid || !ribbonVisible(centroid, frame.yawDeg, frame.noseX)) continue;
    const progress = brushProgress(frame.cycleT, (idx * 0.31) % 1, frame.guided);
    for (const p of samplePath(line, GHOST_SAMPLES)) {
      paintPuff(ctx, p.x * W, p.y * H, W * GHOST_RADIUS, TEACHING_GREY, GHOST_ALPHA);
    }
    const stroke = samplePath(line, STROKE_SAMPLES);
    const alphas = strokeAlphas(stroke.length, progress);
    for (let i = 0; i < stroke.length; i++) {
      const a = alphas[i] ?? 0;
      if (a <= 0) continue;
      const p = stroke[i];
      if (!p) continue;
      paintPuff(ctx, p.x * W, p.y * H, W * STROKE_RADIUS, TEACHING_GREY, a);
    }
  }
}

/**
 * Lesson list for Teach me / Step i of N.
 * `locked` is the snapshot taken when Teach me starts. It wins over a
 * later live shape, including a finishSweep reclassify, until Stop or Done
 * passes null.
 */
export function resolveGuideLesson(
  locked: readonly LessonStep[] | null,
  liveShape: string | null | undefined,
): LessonStep[] {
  if (locked) return locked.slice();
  return liveShape ? buildLesson(liveShape) : [];
}

export interface LiveContourState {
  /** Face shape label from the coach cascade ("oval" default). */
  shape: string;
  /** The layer being taught: shade (1), blush (2), light (3). */
  layer: CoachLayer;
  /** One line of HOW for the current layer + shape, from the chart data. */
  how: string;
}

/** Blush motion spec from rules.json (wikiHow MUA-cited placements). */
interface BlushMotion {
  kind?: string | undefined; from?: string | undefined; to?: string | undefined; center?: string | undefined; guide?: string | undefined; note?: string | undefined; pressure?: string | undefined;
}

/** One teaching line for the current shape's layer (chart brush directions). */
export function howToText(shape: string, layer: CoachLayer): string {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  const spec = rules.shapes[key];
  if (layer === "contour" && spec?.contour?.ribbons?.length) {
    const dirs = spec.contour.ribbons
      .map((r) => rules.brushDirections[r])
      .filter((v, i, a) => v && a.indexOf(v) === i);
    if (dirs.length) return dirs.slice(0, 2).join("; ") + ".";
  }
  if (layer === "blush") {
    const b = spec?.blush as Record<string, unknown> | undefined;
    if (b?.note) return String(b.note).replace(/\.$/, "") + ".";
  }
  if (layer === "highlight" && spec?.highlight?.zones?.length) {
    const dirs = spec.highlight.zones
      .map((z) => rules.brushDirections[z.replace(/_(L|R)$/, "")])
      .filter((v, i, a) => v && a.indexOf(v) === i);
    if (dirs.length) return dirs.slice(0, 2).join("; ") + ".";
  }
  return layer === "contour" ? "Follow the moving dot, ear to mouth." : "Tap light where the glow lands.";
}

/**
 * Drive the overlay loop for one <video>+<canvas> pair. Returns a stop fn.
 * The callback fires on classification changes so the UI can announce the
 * shape and step.
 */
export interface LiveContourHandle {
  stop: () => void;
  setLayer: (l: CoachLayer) => void;
  /** Focus the overlay on one lesson step (null = free explore). */
  setGuide: (step: LessonStep | null) => void;
  /** Start a calibration sweep (user turns head; feed() runs per frame). */
  startSweep: () => SweepState;
  /** Finish the sweep; returns the fused 3D model (null if too few views). */
  finishSweep: () => FaceSweep | null;
  /** The fused model, if a sweep completed. */
  getSweep: () => FaceSweep | null;
  /** Baseline the current step's zones for grading (call at step start). */
  beginGrading: () => void;
  /** Re-grade now against the baseline; returns per-zone + aggregate. */
  gradeNow: () => { feedback: string; score: number; coverage: number } | null;
}

export function startLiveContour(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  modelUrl: string,
  onState?: (s: LiveContourState) => void,
  onSweepProgress?: (s: SweepState) => void,
): LiveContourHandle {
  let stopped = false;
  let lastVideoTime = -1;
  let shape = "oval";
  let shapeStreak = freshShapeStreak();
  let facePresent = false;
  let lastClassifyMs = 0;
  let cm: ContourMap | null = null;
  const meshPts = new Map<number, { x: number; y: number }>();
  let layer: CoachLayer = "contour";

  const setLayer = (l: CoachLayer) => { layer = l; onState?.({ shape, layer, how: howToText(shape, layer) }); };
  let guide: LessonStep | null = null;
  let sweepCollector: ReturnType<typeof createSweepCollector> | null = null;
  let sweep: FaceSweep | null = null;

  // ---- application grading ----
  // Samples come from the RAW VIDEO frame (not the overlay canvas — the
  // grey teaching layer must not pollute its own measurements).
  let gradeBaseline: { poly: Pt2[]; inside: RGB[]; ring: RGB[]; kind: StepKind }[] | null = null;
  const rawCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const sampleAt = (pts: Array<{ x: number; y: number }>): RGB[] => {
    if (!rawCtx || video.videoWidth === 0) return [];
    if (rawCtx.canvas.width !== video.videoWidth) {
      rawCtx.canvas.width = video.videoWidth;
      rawCtx.canvas.height = video.videoHeight;
    }
    rawCtx.drawImage(video, 0, 0, video.videoWidth, video.videoHeight);
    const out: RGB[] = [];
    for (const p of pts) {
      const d = rawCtx.getImageData(Math.min(video.videoWidth - 1, Math.max(0, Math.round(p.x * video.videoWidth))), Math.min(video.videoHeight - 1, Math.max(0, Math.round(p.y * video.videoHeight))), 1, 1).data;
      out.push([d[0]!, d[1]!, d[2]!]);
    }
    return out;
  };
  const gradeTargets = (): { poly: Pt2[]; kind: StepKind }[] => {
    const layerKind: StepKind = layer === "contour" ? "contour" : layer === "blush" ? "blush" : "highlight";
    if (!cm) return [];
    if (layer === "contour") {
      const ids = guide?.ribbonIds ?? contourRibbonsForShape(shape);
      return cm.ribbons.filter((r) => ids.includes(r.id as RibbonId)).map((r) => ({ poly: r.poly as Pt2[], kind: layerKind }));
    }
    if (layer === "blush") {
      return cm.zones.filter((z) => z.id.startsWith("cheek_apple")).map((z) => ({ poly: z.poly as Pt2[], kind: layerKind }));
    }
    const ids = highlightZonesForShape(shape);
    return cm.zones.filter((z) => {
      const base = z.id.replace(/_(L|R)$/, "");
      return ids.includes(base) || ids.includes(z.id);
    }).map((z) => ({ poly: z.poly as Pt2[], kind: layerKind }));
  };
  const beginGrading = () => {
    gradeBaseline = null;
    const targets = gradeTargets();
    if (!targets.length) return;
    gradeBaseline = targets.map((t) => ({
      poly: t.poly,
      kind: t.kind,
      inside: sampleAt(gridInPoly(t.poly)),
      ring: sampleAt(ringAroundPoly(t.poly)),
    }));
  };
  const gradeNow = () => {
    if (!gradeBaseline) return null;
    const results: GradeSample[] = [];
    for (const b of gradeBaseline) {
      const cur = sampleAt(gridInPoly(b.poly));
      const curRing = sampleAt(ringAroundPoly(b.poly));
      if (!cur.length) continue;
      results.push(gradeZone({ kind: b.kind, poly: b.poly, baselineInside: b.inside, currentInside: cur, baselineRing: b.ring, currentRing: curRing }));
    }
    if (!results.length) return null;
    const score = results.reduce((a, r) => a + r.score, 0) / results.length;
    const coverage = results.reduce((a, r) => a + r.coverage, 0) / results.length;
    // worst-first feedback: the zone that needs her attention most
    const worst = [...results].sort((a, b2) => a.score - b2.score)[0]!;
    return { feedback: worst.feedback, score, coverage };
  };
  const setGuide = (step: LessonStep | null) => {
    guide = step;
    if (step) { layer = step.layer; onState?.({ shape, layer, how: step.instruction }); beginGrading(); }
  };
  const startSweep = () => {
    sweepCollector = createSweepCollector();
    sweep = null;
    return sweepCollector.state;
  };
  const finishSweep = () => {
    if (!sweepCollector) return null;
    sweep = sweepCollector.finish();
    sweepCollector = null;
    // Turning the head ends the 1s run. Drop it even when fusion is short
    // or cannot classify, so the next frontal frame cannot finish a
    // pre-sweep flip.
    shapeStreak = freshShapeStreak();
    if (!sweep) return null;
    try {
      // Re-classify from the fused 3D model — multi-view beats any single
      // frame, and the yaw gate no longer applies (we HAVE the views).
      const cls = classifyFromSweep(sweep);
      const primary = cls?.primary ?? "";
      if (!(FACE_SHAPES as readonly string[]).includes(primary)) return sweep;
      if (primary !== shape) shape = primary;
      onState?.({
        shape,
        layer,
        how: guide
          ? guide.instruction
          : `${howToText(shape, layer)} (${sweep.viewCount} views fused)`,
      });
    } catch {
      /* keep the last published shape; the streak is already clear */
    }
    return sweep;
  };
  // Handle returned immediately; stop() is a no-op until the loop starts.

  void loadVideoLandmarker(modelUrl).then((lm) => {
    if (!lm || stopped) return;
    onState?.({ shape, layer, how: howToText(shape, layer) });

    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const draw = () => {
      if (stopped) return;
      requestAnimationFrame(draw);
      const v = video;
      if (v.readyState < 2 || v.videoWidth === 0) return;
      // Match canvas to the video's intrinsic size (CSS scales the pair).
      if (canvas.width !== v.videoWidth || canvas.height !== v.videoHeight) {
        canvas.width = v.videoWidth;
        canvas.height = v.videoHeight;
      }
      const now = performance.now();
      if (v.currentTime !== lastVideoTime) {
        lastVideoTime = v.currentTime;
        let face: Array<{ x: number; y: number }> | undefined;
        let matrix: Float32Array | undefined;
        try {
          const res = lm.detectForVideo(v, now);
          face = res?.faceLandmarks?.[0];
          const m = res?.facialTransformationMatrixes?.[0];
          if (m && m.data && m.data.length === 16) matrix = new Float32Array(m.data);
        } catch {
          face = undefined;
        }
        if (sweepCollector && face && matrix) {
          const st = sweepCollector.feed(face.map((p) => ({ x: p.x, y: p.y, z: (p as { z?: number }).z ?? 0 })), matrix);
          onSweepProgress?.(st);
        }
        if (face && face.length >= 468) {
          const pts = face as CoachPoint[];
          meshPts.clear();
          for (let i = 0; i < pts.length; i++) meshPts.set(i, { x: pts[i]!.x, y: pts[i]!.y });
          const synced = syncShapeStreak(shapeStreak, facePresent, true);
          shapeStreak = synced.streak;
          facePresent = synced.facePresent;
          if (now - lastClassifyMs > 1000) {
            lastClassifyMs = now;
            try {
              const m = measureFace(pts);
              // A failed measure is not an oval vote. classifyFace(null)
              // would say oval at confidence 0 and clear a real run.
              const next = m ? classifyFace(m).primary : null;
              const held = holdShape(shape, next, shapeStreak);
              shapeStreak = held.streak;
              if (held.shape !== shape) {
                shape = held.shape;
                onState?.({
                  shape,
                  layer,
                  how: guide ? guide.instruction : howToText(shape, layer),
                });
              }
            } catch { /* keep last shape and the current run */ }
          }
          try {
            const yawDeg = faceYawDeg(pts[4], pts[234], pts[454]);
            cm = buildContourMap(buildNormalizedRaw(pts), yawDeg);
          } catch {
            cm = null;
          }
        } else {
          const synced = syncShapeStreak(shapeStreak, facePresent, false);
          shapeStreak = synced.streak;
          facePresent = synced.facePresent;
          cm = null;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!cm) {
        publishContourProbe(null);
        return;
      }
      const W = canvas.width, H = canvas.height;
      // Airbrush only (2026-10-11: no SAW face). No polygons, no outlines,
      // no markers: soft radial guides whose motion IS the instruction.
      // The teaching layer stays one neutral grey, drawn straight on this
      // transparent overlay canvas - the client does not simulate product
      // color on the live feed (her own makeup is the only color on
      // screen, and the grader samples the raw video frame). Pigment
      // compositing - soft-light blush, multiply shade, feathered edges -
      // lives on the photo face map (coachOverlay + coach/fill.ts); soft
      // segmentation masks on video are the next step (zll-bisenet).
      // Guided mode: slow, single-step, with a hold at the end of each
      // sweep so she can follow with her own brush.
      const cycle = guide ? 3200 : 1800;
      const t = (performance.now() % cycle) / cycle;

      const paint = (x: number, y: number, r: number, color: [number, number, number], a: number) => {
        if (!(r > 0) || !(a > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return;
        const g = ctx.createRadialGradient(x, y, 0, x, y, r);
        const [cr, cg, cb] = color;
        g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
        g.addColorStop(0.6, `rgba(${cr},${cg},${cb},${(a * 0.45).toFixed(3)})`);
        g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
        ctx.fillStyle = g;
        ctx.beginPath();
        ctx.arc(x, y, r, 0, Math.PI * 2);
        ctx.fill();
      };
      const paintStroke = (
        path: Array<{ x: number; y: number }>,
        color: [number, number, number],
        baseA: number,
        radius: number,
        progress: number,
      ) => {
        const n = path.length;
        if (n < 2) return;
        const upto = Math.max(2, Math.ceil(n * progress));
        for (let i = 0; i < upto; i++) {
          const p = path[i]!;
          const lead = 1 - (upto - 1 - i) / n; // 0..1 toward the head
          const a = baseA * (0.4 + 0.6 * lead) * (0.5 + 0.5 * Math.sin(Math.PI * ((i + 1) / upto)));
          paint(p.x * W, p.y * H, radius, color, Math.min(0.5, a));
        }
      };

      // ONE neutral teaching grey (2026-10-11): color overlays competed
      // with the product she is applying AND polluted the grader's camera
      // samples. Grey directs; her makeup is the only color on screen.
      const GREY: [number, number, number] = TEACHING_GREY;
      const nosePt = meshPts.get(4);
      const yawDeg = faceYawDeg(nosePt, meshPts.get(234), meshPts.get(454));
      const noseX = nosePt?.x ?? 0.5;
      publishContourProbe({
        yawDeg,
        noseX,
        cheeks: cheekRibbonPlacement(cm.ribbons, meshPts, yawDeg, noseX),
        marks: Object.fromEntries(
          [4, 21, 50, 54, 103, 116, 117, 123, 147, 162, 187, 205, 227, 234, 251, 280, 284, 332, 345, 346, 352, 376, 389, 411, 425, 447, 454].map((i) => {
            const p = meshPts.get(i);
            return [String(i), p && Number.isFinite(p.x) && Number.isFinite(p.y) ? { x: p.x, y: p.y } : null];
          }),
        ),
      });

      if (layer === "contour") {
        paintContourLayer(ctx, {
          width: W,
          height: H,
          ribbons: cm!.ribbons,
          liveShape: shape,
          guideIds: guide?.ribbonIds ?? null,
          yawDeg,
          noseX,
          cycleT: t,
          guided: guide != null,
        });
      } else if (layer === "blush") {
        const motion = blushMotionForShape(shape);
        for (const side of ["_L", "_R"] as const) {
          const apple = cm!.zones.find((z) => z.id === "cheek_apple" + side);
          if (!apple || apple.poly.length === 0) continue;
          let sx = 0, sy = 0;
          for (const q of apple.poly) { sx += q.x; sy += q.y; }
          const c = { x: sx / apple.poly.length, y: sy / apple.poly.length };
          if (!ribbonVisible(c, yawDeg, noseX)) continue;
          const at2 = (i: number): { x: number; y: number } => meshPts.get(i) ?? c;
          const P = (idn: string): { x: number; y: number } => {
            switch (idn) {
              case "temple": return at2(side === "_L" ? 67 : 297);
              case "cheek_bone": return at2(side === "_L" ? 116 : 345);
              case "cheek_bone_high": return at2(side === "_L" ? 230 : 450);
              case "apple": return c;
              case "apple_high": return { x: c.x, y: c.y - 0.025 };
              case "ear": case "ear_lobe": return at2(side === "_L" ? 234 : 454);
              case "brow_inner": return at2(side === "_L" ? 107 : 336);
              default: return c;
            }
          };
          const phase = side === "_L" ? 0 : 0.5;
          const tt = (t + phase) % 1;
          if (motion?.kind === "orbit") {
            // Square: soft blush laid in circles on the apples.
            const rr = 0.035;
            for (let k = 0; k < 26; k++) {
              const a = (k / 26) * Math.PI * 2;
              const px = c.x + Math.cos(a) * rr * 0.7;
              const py = c.y + Math.sin(a) * rr * 0.5;
              const done = tt > (k / 26) ? 0.32 : 0.10;
              paint(px * W, py * H, W * 0.05, GREY, done);
            }
          } else if (motion?.kind === "vpath") {
            // Pear: V = bone->temple, then bone->brow.
            const seg = tt < 0.5 ? 0 : 1;
            const u = seg === 0 ? tt * 2 : (tt - 0.5) * 2;
            const a0 = P("cheek_bone");
            const b0 = seg === 0 ? P("temple") : P("brow_inner");
            const base = samplePath([a0, { x: (a0.x + P("temple").x) / 2, y: (a0.y + P("temple").y) / 2 }, P("temple")], 16);
            for (const p of base) paint(p.x * W, p.y * H, W * 0.05, GREY, 0.08);
            paintStroke(samplePath([a0, b0], 16), GREY, 0.22, W * 0.055, u);
          } else {
            const from = P(motion?.from ?? "apple");
            const to = P(motion?.to ?? "temple");
            const mid = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 - 0.012 };
            const path = samplePath([from, mid, to], 20);
            for (const p of path) paint(p.x * W, p.y * H, W * 0.05, GREY, 0.08);
            // Pressure grows toward the cheekbone (heart): scale trail alpha
            // along the sweep instead of dot size.
            const grow = motion?.pressure ? 1.25 : 1;
            paintStroke(path, GREY, 0.22 * grow, W * 0.055, tt);
          }
        }
      } else {
        // Light: a soft glow bloom on each high point, blooming in order.
        const ids = highlightZonesForShape(shape);
        cm!.zones.forEach((z, idx) => {
          const baseId = z.id.replace(/_(L|R)$/, "");
          if (!ids.includes(baseId) && !ids.includes(z.id)) return;
          let sx = 0, sy = 0;
          for (const q of z.poly) { sx += q.x; sy += q.y; }
          const phase = (idx * 0.22) % 1;
          const tt = (t + phase) % 1;
          const bloom = 0.5 - 0.5 * Math.cos(tt * Math.PI * 2); // smooth 0..1..0
          paint((sx / z.poly.length) * W, (sy / z.poly.length) * H, W * (0.055 + 0.02 * bloom), GREY, 0.10 + 0.14 * bloom);
        });
      }
    };
    requestAnimationFrame(draw);
  });

  return {
    stop: () => { stopped = true; },
    setLayer,
    setGuide,
    startSweep,
    finishSweep,
    getSweep: () => sweep,
    beginGrading,
    gradeNow,
  };
}

/**
 * buildContourMap expects NormalizedFace; for the live overlay the polygons
 * are drawn in RAW video fractions, so wrap the raw points in the minimal
 * interface (iod ~ eye distance in frame fractions keeps ribbon widths sane).
 */
function buildNormalizedRaw(pts: CoachPoint[]) {
  const eL = pts[33]!, eR = pts[263]!;
  const iod = Math.hypot(eR.x - eL.x, eR.y - eL.y) || 0.2;
  const points = new Map<number, { x: number; y: number }>();
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    if (p && Number.isFinite(p.x) && Number.isFinite(p.y)) points.set(i, { x: p.x, y: p.y });
  }
  return { points, rollDeg: 0, iod, yawOffset: 0 };
}
