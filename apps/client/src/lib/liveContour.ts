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
 * The yaw gate refuses non-frontal poses — overlay hidden, no wrong map.
 */

import { loadVision } from "./faceMesh.ts";
import { measureFace } from "./coach/measure.ts";
import { classifyFace, FACE_SHAPES, type FaceShape } from "./coach/faceShape.ts";
import { buildContourMap, type ContourMap, type RibbonId } from "./coach/zones.ts";
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
    if (sweep) {
      // Re-classify from the fused 3D model — multi-view beats any single
      // frame, and the yaw gate no longer applies (we HAVE the views).
      const cls = classifyFromSweep(sweep);
      if (cls && FACE_SHAPES.includes(cls.primary as never)) {
        if (cls.primary !== shape) {
          shape = cls.primary;
        }
        onState?.({
          shape,
          layer,
          how: `${howToText(shape, layer)} (${sweep.viewCount} views fused)`,
        });
      }
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
          if (now - lastClassifyMs > 1000) {
            lastClassifyMs = now;
            try {
              const m = measureFace(pts);
              const next = m ? classifyFace(m).primary : "oval";
              if (next !== shape) {
                shape = next;
                onState?.({ shape, layer, how: howToText(shape, layer) });
              }
            } catch { /* keep last shape */ }
          }
          try {
            cm = buildContourMap(buildNormalizedRaw(pts));
          } catch {
            cm = null;
          }
        } else {
          cm = null;
        }
      }

      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!cm) return;
      const W = canvas.width, H = canvas.height;
      // Airbrush only (2026-10-11: no SAW face). No polygons, no outlines,
      // no markers: soft radial product whose motion IS the instruction.
      // All painting happens on one offscreen color layer, composited once
      // per frame with globalCompositeOperation so shade multiplies and
      // light screens - like real product on skin.
      // Guided mode: slow, single-step, with a hold at the end of each
      // sweep so she can follow with her own brush.
      const cycle = guide ? 3200 : 1800;
      const t = (performance.now() % cycle) / cycle;

      const paint = (x: number, y: number, r: number, color: [number, number, number], a: number) => {
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
      // The stroke: a trail of puffs along the path, the leading edge
      // slightly stronger - reads as product being laid down, moving.
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
      const samplePath = (line: Array<{ x: number; y: number }>, steps: number) => {
        const out: Array<{ x: number; y: number }> = [];
        for (let k = 0; k < steps; k++) {
          const f = (k / (steps - 1)) * (line.length - 1);
          const i0 = Math.floor(f);
          const i1 = Math.min(line.length - 1, i0 + 1);
          const u = f - i0;
          const a = line[i0]!, b = line[i1]!; // eslint-disable-line @typescript-eslint/no-unused-vars
          out.push({ x: a.x + (b.x - a.x) * u, y: a.y + (b.y - a.y) * u });
        }
        return out;
      };

      // ONE neutral teaching grey (2026-10-11): color overlays competed
      // with the product she is applying AND polluted the grader's camera
      // samples. Grey directs; her makeup is the only color on screen.
      const GREY: [number, number, number] = [180, 184, 192];
      // Side occlusion: when the head turns, only the visible side's zones
      // mean anything on screen - the far side projects to garbage coords.
      // Visible if the point's x (mirror-space) is on the TURNED-TOWARD
      // side of the face's own midline.
      const sideVisible = (p: { x: number; y: number }): boolean => {
        const mid = meshPts.get(4)?.x ?? 0.5; // nose tip = face midline
        const yawSign = (meshPts.get(4)?.x ?? 0.5) < (meshPts.get(234)!.x + meshPts.get(454)!.x) / 2 ? 1 : -1;
        // facing left (her left): points with x > mid are the near side, etc.
        return yawSign * (p.x - mid) >= -0.02;
      };
      const bothFrontal = Math.abs(faceMidYaw()) < 10;
      function faceMidYaw(): number {
        // crude yaw proxy: nose-tip x offset from ear midpoint, in iod units
        const nose = meshPts.get(4), eL = meshPts.get(234), eR = meshPts.get(454);
        if (!nose || !eL || !eR) return 0;
        return ((nose.x - (eL.x + eR.x) / 2) / Math.hypot(eR.x - eL.x, eR.y - eL.y)) * 60;
      }

      if (layer === "contour") {
        const allIds = contourRibbonsForShape(shape);
        const ids = guide?.ribbonIds ?? allIds;
        allIds.filter((id) => ids.includes(id)).forEach((id, idx) => {
          const r = cm!.ribbons.find((x) => x.id === id);
          if (!r) return;
          const line = (r.centerline ?? []).filter(bothFrontal ? () => true : sideVisible);
          if (line.length >= 2) {
            const phase = (idx * 0.31) % 1;
            let tt = (t + phase) % 1;
            if (guide) tt = Math.min(1, tt / 0.8); // sweep 80%, hold 20%
            for (const p of samplePath(line, 22)) paint(p.x * W, p.y * H, W * 0.045, GREY, 0.08);
            paintStroke(samplePath(line, 22), GREY, 0.22, W * 0.052, tt);
          }
        });
      } else if (layer === "blush") {
        const motion = blushMotionForShape(shape);
        for (const side of ["_L", "_R"] as const) {
          const apple = cm!.zones.find((z) => z.id === "cheek_apple" + side);
          if (!apple) continue;
          // side occlusion: hide the far cheek when the head is turned
          if (!bothFrontal) {
            let sx0 = 0, sy0 = 0;
            for (const q of apple.poly) { sx0 += q.x; sy0 += q.y; }
            if (!sideVisible({ x: sx0 / apple.poly.length, y: sy0 / apple.poly.length })) continue;
          }
          let sx = 0, sy = 0;
          for (const q of apple.poly) { sx += q.x; sy += q.y; }
          const c = { x: sx / apple.poly.length, y: sy / apple.poly.length };
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
