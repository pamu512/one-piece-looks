/**
 * API routes. The server is the only YouCam caller; the client only ever
 * talks to these endpoints.
 *
 *   POST /api/session                      -> { sessionId, rendersBudget }
 *   GET  /api/session/:id                  -> session summary (no photos)
 *   POST /api/session/:id/face             -> run HD skin-type + face-tone
 *   POST /api/session/:id/tone             -> submit picker tone (fallback path)
 *   POST /api/session/:id/looks            -> build 3 looks (mood+event required)
 *   POST /api/session/:id/shuffle          -> re-roll supporting layers
 *
 * Contract rules enforced here:
 * - mood and event are required, no defaults (validated).
 * - exactly three looks; lock hex flows into the locked category only.
 * - render budget shared across build + shuffle; errors don't consume budget.
 */

import type { FastifyInstance, FastifyReply } from "fastify";
import { timingSafeEqual } from "node:crypto";
import { store, type SessionData } from "../session/store.js";
import { YoucamError, runSkinAnalysis, runSkinTone, runMakeupVto, uploadFile } from "../youcam/client.js";
import { mockSkinAnalysis, mockSkinTone } from "../youcam/mock.js";
import { faceCardDataUrl, type FaceLandmarks } from "../youcam/facecard.js";
import {
  buildLooks,
  assembleLook,
  seedFrom,
  oilyRule,
  type BuildInput,
  type BuiltLook,
} from "../domain/builder.js";
import type {
  BuildLooksRequest,
  FaceAnalysisRequest,
  FaceAnalysisResult,
  LooksResult,
  Mood,
  Event,
  SkinType,
  Tone,
  ToneDepth,
  ToneTemperature,
} from "../domain/types.js";
import { MOODS, EVENTS, TONE_DEPTHS } from "../domain/types.js";
import { isHex } from "../domain/color.js";

export interface ApiConfig {
  apiKey?: string | undefined;
  baseUrl: string;
  rendersBudget: number;
  mock: boolean;
  /**
   * Shared demo token (DEMO_TOKEN env). When set, every /api request must
   * carry it as x-demo-token header (or ?demoToken= query for the share
   * card test path). This is NOT user auth - it is the lock on the door
   * before HOST=0.0.0.0 exposes paid renders to venue wifi (review
   * 2026-10-10). Unset = open (local dev default).
   */
  demoToken?: string | undefined;
}

const VALID_SKIN_TYPES: readonly SkinType[] = [
  "Normal",
  "Oily",
  "Dry",
  "Combination",
  "Redness",
  "Dry & Redness",
  "Oily & Redness",
  "Combination & Redness",
];

/** Keep only well-formed landmark polygons (fractional coords 0..1.2). */
function sanitizeLandmarks(raw: unknown): FaceLandmarks | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const r = raw as Record<string, unknown>;
  const poly = (v: unknown): FaceLandmarks["lip"] => {
    if (!Array.isArray(v) || v.length < 3 || v.length > 80) return undefined;
    const out: [number, number][] = [];
    for (const pt of v) {
      if (!Array.isArray(pt) || pt.length !== 2) return undefined;
      const x = Number(pt[0]), y = Number(pt[1]);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
      if (x < -0.1 || x > 1.1 || y < -0.1 || y > 1.1) return undefined;
      out.push([x, y]);
    }
    return out;
  };
  const box = (v: unknown): FaceLandmarks["faceBox"] => {
    if (!v || typeof v !== "object") return undefined;
    const b = v as Record<string, unknown>;
    const x = Number(b.x), y = Number(b.y), w = Number(b.w), h = Number(b.h);
    if (![x, y, w, h].every(Number.isFinite)) return undefined;
    if (w <= 0 || h <= 0 || w > 1.2 || h > 1.2) return undefined;
    return { x, y, w, h };
  };
  const labL = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number.NaN;
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : undefined;
  };
  const labAB = (v: unknown): number | undefined => {
    const n = typeof v === "number" ? v : Number.NaN;
    return Number.isFinite(n) && n >= -128 && n <= 127 ? n : undefined;
  };
  const lipMeanL = labL(r.lipMeanL);
  const lipMeanA = labAB(r.lipMeanA);
  const lipMeanB = labAB(r.lipMeanB);
  const SHAPES = ["long", "round", "square", "heart", "triangle", "diamond", "oval"];
  const shape = typeof r.faceShape === "string" && SHAPES.includes(r.faceShape) ? r.faceShape : undefined;
  const lm: FaceLandmarks = {
    ...(box(r.faceBox) ? { faceBox: box(r.faceBox) } : {}),
    ...(poly(r.lip) ? { lip: poly(r.lip) } : {}),
    ...(poly(r.lipInner) ? { lipInner: poly(r.lipInner) } : {}),
    ...(lipMeanL !== undefined ? { lipMeanL } : {}),
    ...(lipMeanA !== undefined ? { lipMeanA } : {}),
    ...(lipMeanB !== undefined ? { lipMeanB } : {}),
    ...(poly(r.skin) ? { skin: poly(r.skin) } : {}),
    ...(poly(r.eyeL) ? { eyeL: poly(r.eyeL) } : {}),
    ...(poly(r.eyeR) ? { eyeR: poly(r.eyeR) } : {}),
    ...(poly(r.browL) ? { browL: poly(r.browL) } : {}),
    ...(poly(r.browR) ? { browR: poly(r.browR) } : {}),
    ...(poly(r.cheekL) ? { cheekL: poly(r.cheekL) } : {}),
    ...(poly(r.cheekR) ? { cheekR: poly(r.cheekR) } : {}),
    ...(shape ? { faceShape: shape } : {}),
  };
  return Object.keys(lm).length > 0 ? lm : undefined;
}

function isMood(v: unknown): v is Mood {
  return typeof v === "string" && (MOODS as readonly string[]).includes(v);
}
function isEvent(v: unknown): v is Event {
  return typeof v === "string" && (EVENTS as readonly string[]).includes(v);
}
function isToneDepth(v: unknown): v is ToneDepth {
  return typeof v === "string" && (TONE_DEPTHS as readonly string[]).includes(v);
}
function isToneTemp(v: unknown): v is ToneTemperature {
  return v === "warm" || v === "neutral" || v === "cool";
}

function errReply(reply: FastifyReply, status: number, error: string, code: string, retryable: boolean) {
  return reply.code(status).send({ error, code, retryable });
}

export function registerRoutes(app: FastifyInstance, cfg: ApiConfig): void {
  const usingMock = () => cfg.mock || !cfg.apiKey;

  // Shared-token gate: when DEMO_TOKEN is set, every /api call must present
  // it. Constant-time compare; failures are 401 with the standard error
  // shape so the client's calm-error path handles it. Health stays open.
  if (cfg.demoToken) {
    const expected = Buffer.from(cfg.demoToken);
    app.addHook("onRequest", async (req, reply) => {
      const url = req.raw.url ?? "";
      if (!url.startsWith("/api/")) return;
      const presented = (req.headers["x-demo-token"] ?? (req.query as Record<string, unknown>)?.demoToken) ?? "";
      const got = Buffer.from(String(presented));
      const ok = expected.length === got.length && timingSafeEqual(expected, got);
      if (!ok) {
        return errReply(reply, 401, "demo token required (x-demo-token header)", "demo_token_required", false);
      }
    });
  }

  // ----- POST /api/session -----
  app.post("/api/session", async (req, reply) => {
    const s = store.create(cfg.rendersBudget);
    return { sessionId: s.id, rendersBudget: s.rendersBudget, mock: usingMock() };
  });

  // ----- GET /api/session/:id -----
  app.get("/api/session/:id", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return errReply(reply, 404, "session not found", "no_session", false);
    return {
      sessionId: s.id,
      hasFace: Boolean(s.faceImageBase64),
      hasLock: Boolean(s.lock),
      skinType: s.skinType ?? null,
      tone: s.tone ? { ...s.tone } : null,
      toneFallback: s.toneFallback,
      mood: s.mood ?? null,
      event: s.event ?? null,
      rendersLeft: s.rendersBudget - s.rendersUsed,
      mock: usingMock(),
    };
  });

  // ----- POST /api/session/:id/face -----
  app.post("/api/session/:id/face", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return errReply(reply, 404, "session not found", "no_session", false);
    const body = (req.body ?? {}) as FaceAnalysisRequest;
    if (!s.lock && !body.lock) return errReply(reply, 400, "lock required", "no_lock", false);
    if (body.lock) {
      const { category, onFaceHex, productHex, unverified } = body.lock;
      if (!["lip", "cheek", "eye", "brow", "liner"].includes(category))
        return errReply(reply, 400, "invalid category", "bad_lock", false);
      if (!isHex(onFaceHex) || !isHex(productHex))
        return errReply(reply, 400, "lock hexes must be #RRGGBB", "bad_lock", false);
      s.lock = { category, onFaceHex: onFaceHex.toLowerCase(), productHex: productHex.toLowerCase(), unverified: Boolean(unverified) };
    }
    if (typeof body.faceImageBase64 !== "string" || body.faceImageBase64.length < 1000) {
      return errReply(reply, 400, "faceImageBase64 required", "bad_image", false);
    }
    // Optional client face landmarks (additive; used by mock compositing).
    if (body.landmarks) s.landmarks = sanitizeLandmarks(body.landmarks);
    // Retakes must not re-run analysis: only run when not yet analyzed.
    if (s.skinType && s.faceImageBase64 === body.faceImageBase64) {
      // same photo re-posted: idempotent
      const result: FaceAnalysisResult = {
        sessionId: s.id,
        skinType: s.skinType,
        toneFallback: s.toneFallback,
        ...(s.tone
          ? {
              tone: s.tone,
              ...(s.tone.source === "api" ? { toneHex: s.tone.skinColor } : {}),
            }
          : {}),
      };
      return result;
    }
    s.faceImageBase64 = body.faceImageBase64;
    s.lastUsedAt = Date.now();

    let skinType: SkinType | undefined;
    let tone: Tone | undefined;
    let toneFallback = false;

    if (usingMock()) {
      try {
        const m = mockSkinAnalysis(body.faceImageBase64, {});
        if (!VALID_SKIN_TYPES.includes(m.whole as SkinType)) throw new Error("bad mock type");
        skinType = m.whole as SkinType;
      } catch {
        skinType = undefined;
      }
      try {
        const t = mockSkinTone(body.faceImageBase64, {});
        tone = { source: "api", skinColor: t.skinColor };
      } catch {
        toneFallback = true;
      }
    } else {
      try {
        const { fileId } = await uploadFile(cfg.apiKey!, body.faceImageBase64, cfg.baseUrl);
        s.faceFileId = fileId;
        const [analysis, toneRes] = await Promise.allSettled([
          runSkinAnalysis(cfg.apiKey!, fileId, cfg.baseUrl),
          runSkinTone(cfg.apiKey!, fileId, cfg.baseUrl),
        ]);
        if (analysis.status === "fulfilled" && VALID_SKIN_TYPES.includes(analysis.value.whole as SkinType)) {
          skinType = analysis.value.whole as SkinType;
        }
        if (toneRes.status === "fulfilled") {
          tone = { source: "api", skinColor: toneRes.value.skinColor };
        } else {
          toneFallback = true;
        }
      } catch (e) {
        const ye = e as YoucamError;
        return errReply(
          reply,
          ye.code === "face" ? 422 : 502,
          ye.code === "face" ? "face could not be read" : "analysis service unavailable",
          ye.code,
          ye.retryable,
        );
      }
    }

    s.skinType = skinType;
    s.tone = tone;
    s.toneFallback = toneFallback || !tone;

    const result: FaceAnalysisResult = {
      sessionId: s.id,
      ...(skinType ? { skinType } : {}),
      toneFallback: s.toneFallback,
      ...(tone && tone.source === "api" ? { tone, toneHex: tone.skinColor } : {}),
    };
    return result;
  });

  // ----- POST /api/session/:id/tone (picker fallback) -----
  app.post("/api/session/:id/tone", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return errReply(reply, 404, "session not found", "no_session", false);
    const body = (req.body ?? {}) as { depth?: unknown; temperature?: unknown };
    if (!isToneDepth(body.depth) || !isToneTemp(body.temperature)) {
      return errReply(reply, 400, "depth (01-06) and temperature (warm|neutral|cool) required", "bad_tone", false);
    }
    s.tone = { source: "picker", depth: body.depth, temperature: body.temperature };
    s.toneFallback = false;
    return { sessionId: s.id, tone: s.tone };
  });

  // ----- looks build + shuffle share this -----
  async function renderLooks(
    s: SessionData,
    mood: Mood,
    event: Event,
    seedNonce: number,
    reply: FastifyReply,
    idemKey?: string,
    preReserved = false,
  ): Promise<LooksResult | undefined> {
    if (!s.lock || !s.skinType || !s.tone || !s.faceImageBase64) {
      errReply(reply, 409, "face analysis and tone must complete before building looks", "not_ready", false);
      return undefined;
    }
    // Idempotent replay: a client retry of the SAME intent (same key) gets the
    // stored result without spending the budget again. The client's callRetry
    // auto-reposts on retryable errors; without this, a lost response on
    // flaky venue wifi would silently buy 3 more paid renders.
    if (idemKey && s.lastIdemKey === idemKey && s.lastIdemResult) {
      return s.lastIdemResult as LooksResult;
    }
    // Reserve BEFORE building (review 2026-10-10): concurrent /looks and
    // /shuffle must not both pass the check against stale rendersUsed.
    // The shuffle route reserves before bumping shuffleCount; it passes
    // preReserved so we do not double-charge.
    if (!preReserved && !store.reserveRenders(s, 3)) {
      errReply(reply, 429, "render budget for this session is used up", "budget_exhausted", false);
      return undefined;
    }
    const input: BuildInput = {
      lock: s.lock,
      skinType: s.skinType,
      tone: s.tone,
      mood,
      event,
      seed: seedFrom(s.id, seedNonce),
    };
    const built = buildLooks(input);
    const renderOne = async (b: BuiltLook): Promise<LooksResult["looks"][number]> => {
      if (usingMock()) {
        // Mock renders composite the real effect list onto the user's own
        // face photo (API contract: imageUrl is a face render, never an
        // abstract color-bar card).
        return assembleLook(b, faceCardDataUrl(b.role, b.effects, input.seed, s.faceImageBase64!, s.landmarks));
      }
      // Upload once per session; reuse fileId across renders.
      if (!s.faceFileId) {
        const { fileId } = await uploadFile(cfg.apiKey!, s.faceImageBase64!, cfg.baseUrl);
        s.faceFileId = fileId;
      }
      const res = await runMakeupVto(cfg.apiKey!, s.faceFileId!, b.effects, cfg.baseUrl);
      return assembleLook(b, res.imageUrl);
    };
    let looks: LooksResult["looks"];
    try {
      // Parallel: three independent VTO tasks are 3 sequential 2-minute
      // worst-case polls otherwise (~6 min builds). All three share the
      // single reservation; a failure releases it.
      looks = await Promise.all(built.map(renderOne));
    } catch (e) {
      store.releaseRenders(s, 3);
      throw e;
    }
    s.mood = mood;
    s.event = event;
    const result: LooksResult = {
      sessionId: s.id,
      looks,
      rendersLeft: s.rendersBudget - s.rendersUsed,
      lockApproximated: false,
    };
    if (idemKey) {
      s.lastIdemKey = idemKey;
      s.lastIdemResult = result;
    }
    return result;
  }

  // ----- POST /api/session/:id/looks -----
  app.post("/api/session/:id/looks", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return errReply(reply, 404, "session not found", "no_session", false);
    const body = (req.body ?? {}) as BuildLooksRequest;
    if (!isMood(body.mood) || !isEvent(body.event)) {
      return errReply(reply, 400, "mood and event are required", "mood_event_required", false);
    }
    // Fallback tone may arrive with the build request.
    if (!s.tone && body.tone && isToneDepth(body.tone.depth) && isToneTemp(body.tone.temperature)) {
      s.tone = { source: "picker", depth: body.tone.depth, temperature: body.tone.temperature };
      s.toneFallback = false;
    }
    // One idem key per (mood,event) intent per session: retries replay.
    const idemKey = typeof body.idemKey === "string" && body.idemKey.length >= 8 && body.idemKey.length <= 64
      ? `looks:${body.mood}:${body.event}:${body.idemKey}`
      : undefined;
    try {
      const result = await renderLooks(s, body.mood, body.event, s.shuffleCount, reply, idemKey);
      if (result) return result;
    } catch (e) {
      return handleYoucamError(e, reply);
    }
  });

  // ----- POST /api/session/:id/shuffle -----
  app.post("/api/session/:id/shuffle", async (req, reply) => {
    const { id } = req.params as { id: string };
    const s = store.get(id);
    if (!s) return errReply(reply, 404, "session not found", "no_session", false);
    if (!s.mood || !s.event) {
      return errReply(reply, 409, "build looks first", "not_built", false);
    }
    const body = (req.body ?? {}) as { idemKey?: string };
    // Namespace only — no shuffleCount in the key: the count advances on the
    // first attempt, which would mint a different key for the retry and
    // defeat the replay. Client keys are random per intent already.
    const idemKey = typeof body.idemKey === "string" && body.idemKey.length >= 8 && body.idemKey.length <= 64
      ? `shuffle:${body.idemKey}`
      : undefined;
    // A retried shuffle that already completed replays from renderLooks
    // before any reservation; check that first so it does not 429.
    if (!(idemKey && s.lastIdemKey === idemKey && s.lastIdemResult)) {
      if (!store.reserveRenders(s, 3)) {
        return errReply(reply, 429, "render budget for this session is used up", "budget_exhausted", false);
      }
    }
    s.shuffleCount += 1;
    try {
      // renderLooks skips its own reservation when the route pre-reserved.
      const result = await renderLooks(s, s.mood, s.event, s.shuffleCount, reply, idemKey, true);
      if (result) return result;
    } catch (e) {
      return handleYoucamError(e, reply);
    }
  });

  function handleYoucamError(e: unknown, reply: FastifyReply): void {
    if (e instanceof YoucamError) {
      errReply(reply, e.code === "face" ? 422 : 502, e.message, e.code, e.retryable);
      return;
    }
    errReply(reply, 500, "unexpected server error", "unknown", true);
  }
}
