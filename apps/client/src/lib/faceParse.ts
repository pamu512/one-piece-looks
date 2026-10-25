/**
 * One-shot soft face parsing (zll-bisenet resnet18, 19 classes) for the
 * coach face map (plan phase 2 step 3).
 *
 * Loads public/models/zll-bisenet-512-int8.onnx through the same lazy
 * onnxruntime-web wasm path as the face-frame detector (faceModel.ts) and
 * the same session lock; one parse per photo, cached. Any failure (no
 * runtime, missing model, decode error, inference error) resolves null
 * and the face map keeps the step-2 polygon fills: pigment masks are an
 * enhancement, never a dependency.
 *
 * Preprocess mirrors demos/face-parsing/demo.py: the 4:5 photo is drawn
 * stretched onto 512x512 (no letterbox - the face map stretches the same
 * photo to its 1000x1250 viewBox, so grid (x, y) / 512 maps straight back
 * to frame fractions), RGB /255, ImageNet mean/std, CHW float32. The
 * exported graph: input `input` [1,3,512,512], output `logits`
 * [1,19,512,512], then per-pixel softmax here.
 *
 * Class indices (verified against this export with the exported graph on
 * the QA faces, 2026-10-25; demos/face-parsing/demo.py agrees - it reads
 * the nose centroid off class 10): 0 background, 1 skin, 10 nose,
 * 12 u_lip, 13 l_lip, 17 hair. The planes the mask math needs:
 *   skin p[1] + p[10]  (skin and nose are both pigment-bearing skin
 *                       surfaces; the nose bridge highlight dies without
 *                       the union)
 *   lip  p[12] + p[13]
 *   occ  max(p[0], p[17])  - background and hair never glow
 */

import { loadOrtRuntime, releaseOrt, withOrtLock } from "./faceModel.ts";
import type { InferenceSession as OrtSession, Tensor as OrtTensor } from "onnxruntime-web";

const MODEL_URL = "models/zll-bisenet-512-int8.onnx";

/** Model input is square 512; the photo is stretched, not letterboxed. */
export const PARSE_SIZE = 512;

export const PARSE_CLASSES = {
  bg: 0,
  skin: 1,
  nose: 10,
  uLip: 12,
  lLip: 13,
  hair: 17,
} as const;

/** Class count the export is fixed at; anything else is not this graph. */
export const PARSE_CLASS_COUNT = 19;

const MEAN = [0.485, 0.456, 0.406] as const;
const STD = [0.229, 0.224, 0.225] as const;

/** Soft probability planes on the PARSE_SIZE grid, row-major. */
export interface ParsePlanes {
  size: number;
  skin: Float32Array;
  lip: Float32Array;
  occ: Float32Array;
}

/** pigment masks off for this page load: ?softmasks=0|off|false. */
export function softMasksDisabled(): boolean {
  try {
    const v = new URLSearchParams(window.location.search).get("softmasks");
    return v === "0" || v === "off" || v === "false";
  } catch {
    return false;
  }
}

let sessionPromise: Promise<OrtSession | null> | null = null;

/** Fetch + create the session once; concurrent callers share the promise. */
function loadParseSession(): Promise<OrtSession | null> {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      const ort = await loadOrtRuntime();
      if (!ort) return null;
      try {
        const buf = await fetch(MODEL_URL).then((r) => r.arrayBuffer());
        return await withOrtLock(() =>
          ort.InferenceSession.create(new Uint8Array(buf), { executionProviders: ["wasm"] }),
        );
      } catch {
        return null;
      }
    })();
  }
  return sessionPromise;
}

function loadImage(src: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

/** Stretched draw + ImageNet normalize + HWC->CHW. Null when 2D is unavailable. */
function preprocess(img: HTMLImageElement): Float32Array | null {
  const canvas = document.createElement("canvas");
  canvas.width = PARSE_SIZE;
  canvas.height = PARSE_SIZE;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(img, 0, 0, PARSE_SIZE, PARSE_SIZE);
  let px: Uint8ClampedArray;
  try {
    px = ctx.getImageData(0, 0, PARSE_SIZE, PARSE_SIZE).data;
  } catch {
    return null;
  }
  const n = PARSE_SIZE * PARSE_SIZE;
  const data = new Float32Array(3 * n);
  for (let i = 0; i < n; i++) {
    for (let c = 0; c < 3; c++) {
      data[c * n + i] = ((px[i * 4 + c] ?? 0) / 255 - MEAN[c]!) / STD[c]!;
    }
  }
  return data;
}

/**
 * Per-pixel softmax over the 19 classes, reduced to the three planes the
 * mask math needs: skin = p(skin) + p(nose) - the model splits
 * pigment-bearing skin into two classes and the nose bridge highlight
 * needs both. Layout CHW: logits[c * n + y * size + x]. Returns null
 * for a plane-sized mismatch (not this graph); non-finite rows resolve to
 * all-zero planes at that pixel, the safe (paint-nothing) direction.
 */
export function planesFromLogits(logits: Float32Array): ParsePlanes | null {
  const n = PARSE_SIZE * PARSE_SIZE;
  if (logits.length !== PARSE_CLASS_COUNT * n) return null;
  const skin = new Float32Array(n);
  const lip = new Float32Array(n);
  const occ = new Float32Array(n);
  const exps = new Float32Array(PARSE_CLASS_COUNT);
  for (let i = 0; i < n; i++) {
    let max = -Infinity;
    for (let c = 0; c < PARSE_CLASS_COUNT; c++) {
      const v = logits[c * n + i] ?? 0;
      if (Number.isFinite(v) && v > max) max = v;
    }
    if (!Number.isFinite(max)) continue;
    let sum = 0;
    for (let c = 0; c < PARSE_CLASS_COUNT; c++) {
      const v = logits[c * n + i] ?? 0;
      const e = Number.isFinite(v) ? Math.exp(v - max) : 0;
      exps[c] = e;
      sum += e;
    }
    if (!(sum > 0)) continue;
    const p = (c: number): number => (exps[c] ?? 0) / sum;
    skin[i] = p(PARSE_CLASSES.skin) + p(PARSE_CLASSES.nose);
    lip[i] = p(PARSE_CLASSES.uLip) + p(PARSE_CLASSES.lLip);
    occ[i] = Math.max(p(PARSE_CLASSES.bg), p(PARSE_CLASSES.hair));
  }
  return { size: PARSE_SIZE, skin, lip, occ };
}

async function runSession(data: Float32Array): Promise<ParsePlanes | null> {
  const session = await loadParseSession();
  const ort = await loadOrtRuntime();
  if (!session || !ort) return null;
  return withOrtLock(async () => {
    const tensor = new ort.Tensor("float32", data, [1, 3, PARSE_SIZE, PARSE_SIZE]);
    let out: Record<string, OrtTensor> | undefined;
    try {
      const inputName = session.inputNames[0] ?? "input";
      out = await session.run({ [inputName]: tensor });
      const first = Object.values(out)[0];
      if (!first) return null;
      return planesFromLogits(first.data as Float32Array);
    } catch {
      return null;
    } finally {
      releaseOrt(tensor);
      if (out) for (const t of Object.values(out)) releaseOrt(t);
    }
  });
}

const planeCache = new Map<string, Promise<ParsePlanes | null>>();
const PLANE_CACHE_MAX = 3;

/**
 * Parse one photo (data URL) once; concurrent callers share the promise
 * and repeat photos hit the cache. Never throws: null means no masks for
 * this page load and the face map renders the step-2 polygon fills.
 */
export function parseFacePhoto(photo: string): Promise<ParsePlanes | null> {
  if (typeof photo !== "string" || photo.length === 0 || softMasksDisabled()) {
    return Promise.resolve(null);
  }
  let p = planeCache.get(photo);
  if (!p) {
    p = (async () => {
      const img = await loadImage(photo);
      if (!img || !(img.naturalWidth > 0)) return null;
      const data = preprocess(img);
      if (!data) return null;
      return runSession(data);
    })();
    planeCache.set(photo, p);
    while (planeCache.size > PLANE_CACHE_MAX) {
      const oldest = planeCache.keys().next().value;
      if (oldest === undefined) break;
      planeCache.delete(oldest);
    }
  }
  return p;
}
