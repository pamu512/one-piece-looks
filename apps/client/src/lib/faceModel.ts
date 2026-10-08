/**
 * Lazy ONNX face-frame detector (optional accelerator, never a dependency).
 *
 * Loads apps/client/public/models/face-frame.onnx with onnxruntime-web ONLY
 * when it is already available; a missing runtime, missing model, or any
 * inference error resolves to null and detectFace() falls back to the
 * skin-grid heuristic. Mock mode and offline dev stay fully functional.
 *
 * The exported graph: input float32 [1,3,480,480] (RGB 0..1, letterboxed
 * onto a gray 114 canvas by prep below), output float32 [1,4,8400] from
 * YOLO11 export (cxcywh + conf; single class).
 */

import type { FaceBox } from "./face";

const MODEL_URL = "models/face-frame.onnx";
const INPUT = 480;
const CONF_THRESHOLD = 0.5;

import type { InferenceSession as OrtSession, Tensor as OrtTensor } from "onnxruntime-web";

type OrtModule = {
  InferenceSession: typeof import("onnxruntime-web").InferenceSession;
  Tensor: typeof import("onnxruntime-web").Tensor;
};

let sessionPromise: Promise<OrtSession | null> | null = null;

/**
 * Resolve onnxruntime-web lazily via a dynamic import, so the runtime is
 * only fetched when a photo is actually processed. Any failure (offline,
 * blocked chunk, no wasm support) permanently resolves null for this page
 * load and the detector falls back to the heuristic.
 *
 * Shared with the face-parsing session. numThreads stays 1: the wasm
 * pthread build needs cross-origin isolation this page does not set, and
 * the int8 parse graph was checked on the single-thread wasm EP.
 */
let ortModule: OrtModule | null | undefined;

type OrtWithEnv = OrtModule & { env?: { wasm?: { numThreads?: number } } };

export async function loadOrtRuntime(): Promise<OrtModule | null> {
  if (ortModule !== undefined) return ortModule;
  try {
    const mod = (await import("onnxruntime-web/wasm")) as unknown as { default?: OrtWithEnv } & OrtWithEnv;
    const ort = (mod.default ?? mod) as OrtWithEnv;
    if (ort.env?.wasm) ort.env.wasm.numThreads = 1;
    ortModule = ort;
  } catch {
    ortModule = null;
  }
  return ortModule;
}

let ortTail: Promise<void> = Promise.resolve();

/**
 * The wasm EP is one runtime. Overlapping session.run calls corrupt it,
 * so the face-frame session and the lip-parse session share this queue.
 */
export function withOrtLock<T>(job: () => Promise<T>): Promise<T> {
  const prev = ortTail;
  let release: () => void = () => {};
  ortTail = new Promise<void>((resolve) => { release = resolve; });
  return prev.then(job).finally(release);
}

export function releaseOrt(tensor: { dispose?: () => void } | null | undefined): void {
  try { tensor?.dispose?.(); } catch { /* buffer already released */ }
}

/**
 * Fetch the model once; concurrent callers share the promise. Any failure
 * (404, no runtime) permanently resolves null for this page load.
 */
export function loadFaceFrameSession(): Promise<OrtSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrtRuntime();
      if (!ort) return null;
      try {
        const buf = await fetch(MODEL_URL).then((r) => r.arrayBuffer());
        return await withOrtLock(() => ort.InferenceSession.create(new Uint8Array(buf), {
          executionProviders: ["wasm"],
        }));
      } catch {
        return null;
      }
    })();
  }
  return sessionPromise;
}

/** Letterbox the normalized 4:5 canvas onto the square model input. */
function letterbox(ctx: CanvasRenderingContext2D): { data: Float32Array; scale: number; padX: number; padY: number } {
  const src = ctx.getImageData(0, 0, ctx.canvas.width, ctx.canvas.height);
  const W = ctx.canvas.width, H = ctx.canvas.height;
  const scale = Math.min(INPUT / W, INPUT / H);
  const dw = Math.round(W * scale), dh = Math.round(H * scale);
  const padX = Math.floor((INPUT - dw) / 2), padY = Math.floor((INPUT - dh) / 2);

  const outCanvas = document.createElement("canvas");
  outCanvas.width = INPUT; outCanvas.height = INPUT;
  const octx = outCanvas.getContext("2d", { willReadFrequently: true });
  if (!octx) return { data: new Float32Array(0), scale, padX, padY };
  octx.fillStyle = "#727272"; // YOLO letterbox gray (114)
  octx.fillRect(0, 0, INPUT, INPUT);
  // Re-draw the source canvas scaled (reuse pixels; no second decode).
  octx.drawImage(ctx.canvas, padX, padY, dw, dh);
  const px = octx.getImageData(0, 0, INPUT, INPUT).data;

  const data = new Float32Array(3 * INPUT * INPUT);
  // HWC -> CHW, RGB, 0..1. Ultralytics export normalize: /255.
  const n = INPUT * INPUT;
  for (let i = 0; i < n; i++) {
    const r = px[i * 4] ?? 0, g = px[i * 4 + 1] ?? 0, b = px[i * 4 + 2] ?? 0;
    data[i] = r / 255;
    data[n + i] = g / 255;
    data[2 * n + i] = b / 255;
  }
  return { data, scale, padX, padY };
}

export interface ModelFaceBox {
  box: FaceBox; // fractions of the 4:5 frame
  conf: number;
}

/**
 * Run the detector on the normalized canvas. Returns the single most
 * confident face above the threshold, or null. Never throws.
 */
export async function detectFaceFrameModel(canvas: HTMLCanvasElement): Promise<ModelFaceBox | null> {
  const session = await loadFaceFrameSession();
  if (!session) return null;
  const ort = await loadOrtRuntime();
  if (!ort) return null;
  try {
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    const { data, scale, padX, padY } = letterbox(ctx);
    if (data.length === 0) return null;
    const inputName = session.inputNames[0] ?? "images";
    return await withOrtLock(async () => {
      const tensor = new ort.Tensor("float32", data, [1, 3, INPUT, INPUT]);
      let out: Record<string, OrtTensor> | undefined;
      try {
        out = await session.run({ [inputName]: tensor });
        const first = Object.values(out)[0];
        if (!first) return null;

        // YOLO11 ONNX export: [1, 4+nc, N] with nc=1 -> [1,5,8400] cxcywh+conf.
        const y = first.data as Float32Array;
        const dims = first.dims as number[];
        const rows = Number(dims[1]) || 5;
        const n = Number(dims[2]) || y.length / rows;
        const H = canvas.height, W = canvas.width;

        let bestConf = 0, best = -1;
        for (let i = 0; i < n; i++) {
          const conf = y[(rows - 1) * n + i] ?? 0;
          if (conf > bestConf) { bestConf = conf; best = i; }
        }
        if (best < 0 || bestConf < CONF_THRESHOLD) return null;

        // Model space -> 480 canvas space -> original canvas fractions.
        const mx = y[best] ?? 0, my = y[n + best] ?? 0, mw = y[2 * n + best] ?? 0, mh = y[3 * n + best] ?? 0;
        const inv = 1 / scale;
        const x0 = (mx - mw / 2) * inv - padX * inv;
        const y0 = (my - mh / 2) * inv - padY * inv;
        const w = mw * inv, h = mh * inv;
        return {
          box: {
            x: Math.max(0, Math.min(1, x0 / W)),
            y: Math.max(0, Math.min(1, y0 / H)),
            w: Math.min(1, w / W),
            h: Math.min(1, h / H),
          },
          conf: bestConf,
        };
      } finally {
        releaseOrt(tensor);
        if (out) for (const t of Object.values(out)) releaseOrt(t);
      }
    });
  } catch {
    return null;
  }
}
