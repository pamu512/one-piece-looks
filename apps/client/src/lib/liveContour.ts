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

  const setLayer = (l: "contour" | "highlight") => { layer = l; onState?.({ shape, layer }); };
  // Handle returned immediately; stop() is a no-op until the loop starts.

  void loadVideoLandmarker(modelUrl).then((lm) => {
    if (!lm || stopped) return;
    onState?.({ shape, layer });

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
                onState?.({ shape, layer });
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

      const ribbons = layer === "contour"
        ? contourRibbonsForShape(shape)
        : (highlightZonesForShape(shape).flatMap((z) => (z.endsWith("_L") || z.endsWith("_R") ? [z as RibbonId] : [])) as RibbonId[]);
      const W = canvas.width, H = canvas.height;

      if (layer === "contour") {
        for (const id of ribbons) {
          const r = cm.ribbons.find((x) => x.id === id);
          if (!r) continue;
          ctx.beginPath();
          const poly = r.poly;
          for (let i = 0; i < poly.length; i++) {
            const p = poly[i]!;
            if (i === 0) ctx.moveTo(p.x * W, p.y * H);
            else ctx.lineTo(p.x * W, p.y * H);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(140, 82, 46, 0.34)";
          ctx.fill();
          ctx.strokeStyle = "rgba(220, 170, 120, 0.9)";
          ctx.lineWidth = Math.max(2, W * 0.004);
          ctx.stroke();
        }
      } else {
        for (const zid of highlightZonesForShape(shape)) {
          const z = cm.zones.find((x) => x.id === zid || x.id === zid + "_L" || x.id === zid + "_R");
          if (!z) continue;
          ctx.beginPath();
          for (let i = 0; i < z.poly.length; i++) {
            const p = z.poly[i]!;
            if (i === 0) ctx.moveTo(p.x * W, p.y * H);
            else ctx.lineTo(p.x * W, p.y * H);
          }
          ctx.closePath();
          ctx.fillStyle = "rgba(255, 240, 214, 0.30)";
          ctx.fill();
          ctx.strokeStyle = "rgba(255, 224, 178, 0.9)";
          ctx.lineWidth = Math.max(2, W * 0.004);
          ctx.stroke();
        }
        // zones catalog stores L/R pairs; base ids like cheek_apple need both
        for (const z of cm.zones) {
          const base = z.id.replace(/_(L|R)$/, "");
          if (highlightZonesForShape(shape).includes(base) || highlightZonesForShape(shape).includes(z.id)) {
            ctx.beginPath();
            for (let i = 0; i < z.poly.length; i++) {
              const p = z.poly[i]!;
              if (i === 0) ctx.moveTo(p.x * W, p.y * H);
              else ctx.lineTo(p.x * W, p.y * H);
            }
            ctx.closePath();
            ctx.fillStyle = "rgba(255, 240, 214, 0.30)";
            ctx.fill();
            ctx.strokeStyle = "rgba(255, 224, 178, 0.9)";
          }
          ctx.stroke();
        }
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
