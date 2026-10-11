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

type FaceLandmarker = import("@mediapipe/tasks-vision").FaceLandmarker;

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

/** The highlight zones a shape's chart rule lights. */
export function highlightZonesForShape(shape: string): string[] {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  return rules.shapes[key]?.highlight?.zones ?? [];
}

export interface LiveContourState {
  /** Face shape label from the coach cascade ("oval" default). */
  shape: string;
  /** Whether the plan currently shows contour (step 1) or highlight (step 2). */
  layer: "contour" | "highlight";
  /** One line of HOW for the current layer + shape, from the chart data. */
  how: string;
}

/** One teaching line for the current shape's layer (chart brush directions). */
export function howToText(shape: string, layer: "contour" | "highlight"): string {
  const key = (FACE_SHAPES as readonly string[]).includes(shape) ? (shape as FaceShape) : "oval";
  const spec = rules.shapes[key];
  if (layer === "contour" && spec?.contour?.ribbons?.length) {
    const dirs = spec.contour.ribbons
      .map((r) => rules.brushDirections[r])
      .filter((v, i, a) => v && a.indexOf(v) === i);
    if (dirs.length) return dirs.slice(0, 2).join("; ") + ".";
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
  setLayer: (l: "contour" | "highlight") => void;
}

export function startLiveContour(
  video: HTMLVideoElement,
  canvas: HTMLCanvasElement,
  modelUrl: string,
  onState?: (s: LiveContourState) => void,
): LiveContourHandle {
  let stopped = false;
  let lastVideoTime = -1;
  let shape = "oval";
  let lastClassifyMs = 0;
  let cm: ContourMap | null = null;
  let layer: "contour" | "highlight" = "contour";

  const setLayer = (l: "contour" | "highlight") => { layer = l; onState?.({ shape, layer, how: howToText(shape, layer) }); };
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
        try {
          face = lm.detectForVideo(v, now)?.faceLandmarks?.[0];
        } catch {
          face = undefined;
        }
        if (face && face.length >= 468) {
          const pts = face as CoachPoint[];
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
      const lw = Math.max(2.5, W * 0.005);
      // Shared animation clock: one stroke-cycle ~1.8s, phase-shifted per
      // ribbon so the strokes read sequentially, not as one blinking blob.
      const t = (performance.now() % 1800) / 1800;

      const drawArrow = (from: { x: number; y: number }, to: { x: number; y: number }, headLen: number) => {
        const a = Math.atan2(to.y - from.y, to.x - from.x);
        ctx.beginPath();
        ctx.moveTo(to.x, to.y);
        ctx.lineTo(to.x - headLen * Math.cos(a - Math.PI / 6), to.y - headLen * Math.sin(a - Math.PI / 6));
        ctx.lineTo(to.x - headLen * Math.cos(a + Math.PI / 6), to.y - headLen * Math.sin(a + Math.PI / 6));
        ctx.closePath();
        ctx.fill();
      };

      if (layer === "contour") {
        const ids = contourRibbonsForShape(shape);
        ids.forEach((id, idx) => {
          const r = cm!.ribbons.find((x) => x.id === id);
          if (!r) return;
          // Soft region: WHERE.
          ctx.beginPath();
          for (let i = 0; i < r.poly.length; i++) {
            const p = r.poly[i]!;
            if (i === 0) ctx.moveTo(p.x * W, p.y * H);
            else ctx.lineTo(p.x * W, p.y * H);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(140, 82, 46, 0.30)";
          ctx.fill();
          ctx.strokeStyle = "rgba(214, 158, 110, 0.75)";
          ctx.lineWidth = lw;
          ctx.stroke();

          const line = r.centerline ?? [];
          if (line.length >= 2) {
            const phase = (idx * 0.31) % 1;
            const tt = (t + phase) % 1;
            const f = tt * (line.length - 1);
            const i0 = Math.floor(f);
            const i1 = Math.min(line.length - 1, i0 + 1);
            const u = f - i0;
            const a = line[i0]!, b = line[i1]!;
            const pos = { x: (a.x + (b.x - a.x) * u) * W, y: (a.y + (b.y - a.y) * u) * H };
            const prev = i0 > 0 ? line[i0 - 1]! : a;
            const headLen = Math.max(14, W * 0.05);
            // HOW: an animated dot sweeping the brush path, trailing an
            // arrowhead in the stroke direction, plus a start marker.
            const start = line[0]!;
            ctx.beginPath();
            ctx.arc(start.x * W, start.y * H, Math.max(6, W * 0.014), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 224, 178, 0.95)";
            ctx.fill();
            ctx.beginPath();
            ctx.arc(pos.x, pos.y, Math.max(9, W * 0.020), 0, Math.PI * 2);
            ctx.fillStyle = "rgba(255, 240, 214, 0.95)";
            ctx.fill();
            ctx.strokeStyle = "rgba(180, 90, 40, 0.95)";
            ctx.lineWidth = lw * 0.8;
            ctx.stroke();
            drawArrow(prev, pos, headLen);
          }
        });
      } else {
        // Light layer: zones glow where highlight lands, each pulsing in
        // sequence; a small dot marks the anchor to tap first.
        const ids = highlightZonesForShape(shape);
        cm.zones.forEach((z, idx) => {
          const base = z.id.replace(/_(L|R)$/, "");
          if (!ids.includes(base) && !ids.includes(z.id)) return;
          const phase = (idx * 0.22) % 1;
          const tt = (t + phase) % 1;
          const pulse = 0.24 + 0.14 * Math.sin(tt * Math.PI);
          ctx.beginPath();
          for (let i = 0; i < z.poly.length; i++) {
            const p = z.poly[i]!;
            if (i === 0) ctx.moveTo(p.x * W, p.y * H);
            else ctx.lineTo(p.x * W, p.y * H);
          }
          ctx.closePath();
          ctx.fillStyle = `rgba(255, 240, 214, ${pulse.toFixed(3)})`;
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 224, 178, 0.85)";
          ctx.lineWidth = lw;
          ctx.stroke();
          let sx = 0, sy = 0;
          for (const p of z.poly) { sx += p.x; sy += p.y; }
          sx = (sx / z.poly.length) * W; sy = (sy / z.poly.length) * H;
          ctx.beginPath();
          ctx.arc(sx, sy, Math.max(5, W * 0.011), 0, Math.PI * 2);
          ctx.fillStyle = "rgba(255, 250, 235, 0.95)";
          ctx.fill();
        });
      }
    };
    requestAnimationFrame(draw);
  });

  return {
    stop: () => { stopped = true; },
    setLayer,
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
