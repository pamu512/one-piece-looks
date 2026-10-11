/* Shared client types mirroring API-CONTRACT.md exactly. */

export type Category = "lip" | "cheek" | "eye" | "brow" | "liner";

export const CATEGORIES: { id: Category; label: string; blurb: string }[] = [
  { id: "lip", label: "Lip", blurb: "Bullet or gloss" },
  { id: "cheek", label: "Cheek", blurb: "Blush, pan or cream" },
  { id: "eye", label: "Eye", blurb: "Shadow, one shade" },
  { id: "brow", label: "Brow", blurb: "Pencil or pomade" },
  { id: "liner", label: "Liner", blurb: "Pencil or liquid" },
];

export const MOODS = [
  "Bitch mode", "Boss", "Demure", "Owning it",
  "Sexy", "Soft", "Clean", "Main character",
] as const;
export type Mood = (typeof MOODS)[number];

export const EVENTS = [
  "Dinner date", "Office", "Casual", "Workout",
  "Night out", "Wedding guest", "Errands", "Interview",
] as const;
export type Event = (typeof EVENTS)[number];

export type SkinType =
  | "Normal" | "Oily" | "Dry" | "Combination"
  | "Redness" | "Dry & Redness" | "Oily & Redness" | "Combination & Redness";

export type Tone =
  | { source: "api"; skinColor: string }
  | { source: "picker"; depth: string; temperature: string };

export interface ApiErrorShape { error: string; code: string; retryable: boolean }

export interface SessionInfo { sessionId: string; rendersBudget: number; mock: boolean }

export interface FaceResult {
  sessionId: string;
  /** Null when skin analysis failed server-side (contract: nullable). */
  skinType: SkinType | null;
  toneFallback: boolean;
  tone: Tone;
  toneHex: string;
}

export interface ToneResult { sessionId: string; tone: Tone }

export interface LookChip { label: string; detail: string; hex: string }
export interface ShopRef { label: string; url: string }
export interface Look {
  role: "anchor" | "lift" | "statement";
  imageUrl: string;
  chips: LookChip[];
  shop?: ShopRef;
  lockApproximated?: boolean;
}
export interface LooksResult {
  sessionId: string;
  looks: Look[];
  rendersLeft: number;
  lockApproximated: boolean;
}

export class ApiError extends Error {
  code: string;
  retryable: boolean;
  constructor(e: ApiErrorShape) {
    super(e.error);
    this.code = e.code;
    this.retryable = e.retryable;
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  // Demo token: set VITE_DEMO_TOKEN at build/dev time to match the server's
  // DEMO_TOKEN (required whenever the server is exposed beyond localhost).
  const headers: Record<string, string> = { "content-type": "application/json" };
  const demoToken = import.meta.env.VITE_DEMO_TOKEN as string | undefined;
  if (demoToken) headers["x-demo-token"] = demoToken;
  const res = await fetch(path, {
    ...init,
    headers: { ...headers, ...(init?.headers as Record<string, string> | undefined) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const shape = (body ?? {}) as Partial<ApiErrorShape>;
    throw new ApiError({
      error: shape.error ?? `Request failed (${res.status})`,
      code: shape.code ?? `http_${res.status}`,
      retryable: shape.retryable ?? res.status >= 500,
    });
  }
  return body as T;
}

/** Idempotency key for one build/shuffle intent (money safety with retries). */
export function newIdemKey(): string {
  return Math.random().toString(36).slice(2, 10) + Date.now().toString(36);
}

/** Optional face landmarks sent with POST /face (fractional 4:5 coords). */
export interface FaceLandmarksPayload {
  faceBox?: { x: number; y: number; w: number; h: number };
  lip?: [number, number][];
  lipInner?: [number, number][];
  /** CIE L* of the lip flesh, 0..100. */
  lipMeanL?: number;
  /** CIE a* of the lip flesh, -128..127. */
  lipMeanA?: number;
  /** CIE b* of the lip flesh, -128..127. */
  lipMeanB?: number;
  /** Class-1 skin contour. */
  skin?: [number, number][];
  eyeL?: [number, number][];
  eyeR?: [number, number][];
  browL?: [number, number][];
  browR?: [number, number][];
  cheekL?: [number, number][];
  cheekR?: [number, number][];
}

/* fetch wrapper with exactly-once retry on retryable errors. */
async function callRetry<T>(path: string, init?: RequestInit): Promise<T> {
  try {
    return await call<T>(path, init);
  } catch (e) {
    if (e instanceof ApiError && e.retryable) return call<T>(path, init);
    throw e;
  }
}

export const api = {
  createSession: () => callRetry<SessionInfo>("/api/session", { method: "POST", body: "{}" }),

  postFace: (id: string, faceImageBase64: string, lock: {
    category: Category; onFaceHex: string; productHex: string; unverified: boolean;
  }, landmarks?: FaceLandmarksPayload) => callRetry<FaceResult>(`/api/session/${id}/face`, {
    method: "POST",
    body: JSON.stringify({ faceImageBase64, lock, ...(landmarks ? { landmarks } : {}) }),
  }),

  postTone: (id: string, depth: string, temperature: "warm" | "neutral" | "cool") =>
    callRetry<ToneResult>(`/api/session/${id}/tone`, {
      method: "POST",
      body: JSON.stringify({ depth, temperature }),
    }),

  postLooks: (id: string, mood: Mood, event: Event, idemKey?: string) =>
    callRetry<LooksResult>(`/api/session/${id}/looks`, {
      method: "POST",
      body: JSON.stringify({ mood, event, ...(idemKey ? { idemKey } : {}) }),
    }),

  postShuffle: (id: string, idemKey?: string) =>
    callRetry<LooksResult>(`/api/session/${id}/shuffle`, {
      method: "POST",
      body: JSON.stringify(idemKey ? { idemKey } : {}),
    }),
};

export const TONE_DEPTHS = ["01", "02", "03", "04", "05", "06"] as const;

/* ---------- color helpers ---------- */

export function rgbToHex(r: number, g: number, b: number): string {
  const h = (n: number) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

export function hexToRgb(h: string): { r: number; g: number; b: number } {
  const s = h.replace("#", "");
  const r = parseInt(s.slice(0, 2), 16);
  const g = parseInt(s.slice(2, 4), 16);
  const b = parseInt(s.slice(4, 6), 16);
  return { r: Number.isNaN(r) ? 0 : r, g: Number.isNaN(g) ? 0 : g, b: Number.isNaN(b) ? 0 : b };
}

/** Sample a small disk around (x,y): average with outlier trim (drop the
    20% of pixels furthest from the mean) so glare specks don't skew the hex. */
export function sampleDisk(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius = 10,
): string {
  const r = Math.max(3, Math.round(radius));
  const data = ctx.getImageData(x - r, y - r, r * 2 + 1, r * 2 + 1).data;
  const px: { r: number; g: number; b: number }[] = [];
  for (let i = 0; i < data.length; i += 4) {
    const dx = (i / 4) % (r * 2 + 1) - r;
    const dy = Math.floor(i / 4 / (r * 2 + 1)) - r;
    if (dx * dx + dy * dy <= r * r) {
      const rr = data[i] ?? 0, gg = data[i + 1] ?? 0, bb = data[i + 2] ?? 0;
      px.push({ r: rr, g: gg, b: bb });
    }
  }
  if (px.length === 0) return "#000000";
  let mr = px.reduce((a, p) => a + p.r, 0) / px.length;
  let mg = px.reduce((a, p) => a + p.g, 0) / px.length;
  let mb = px.reduce((a, p) => a + p.b, 0) / px.length;
  // trim outliers: keep the 80% closest to mean
  const d = px.map((p) => Math.hypot(p.r - mr, p.g - mg, p.b - mb)).sort((a, b) => a - b);
  const cut = d[Math.floor(d.length * 0.8)] ?? Infinity;
  const keep = px.filter((_, i) => (d[i] ?? Infinity) <= cut);
  if (keep.length > 0) {
    mr = keep.reduce((a, p) => a + p.r, 0) / keep.length;
    mg = keep.reduce((a, p) => a + p.g, 0) / keep.length;
    mb = keep.reduce((a, p) => a + p.b, 0) / keep.length;
  }
  return rgbToHex(mr, mg, mb);
}

/** Perceptual-ish distance between two hex colors (weighted RGB). */
export function colorDistance(a: string, b: string): number {
  const pa = hexToRgb(a), pb = hexToRgb(b);
  const rm = (pa.r + pb.r) / 2;
  const dr = pa.r - pb.r, dg = pa.g - pb.g, db = pa.b - pb.b;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db);
}

/** Rough luminance contrast ratio between two hexes. */
export function contrastRatio(a: string, b: string): number {
  const lum = (h: string) => {
    const { r, g, b } = hexToRgb(h);
    const f = (c: number) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : Math.pow((c / 255 + 0.055) / 1.055, 2.4));
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const l1 = lum(a), l2 = lum(b);
  return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
}

export function setLockAccent(hex: string) {
  document.documentElement.style.setProperty("--lock-hex", hex);
}
