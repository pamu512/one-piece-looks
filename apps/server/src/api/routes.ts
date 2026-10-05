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
  const lm: FaceLandmarks = {
    ...(box(r.faceBox) ? { faceBox: box(r.faceBox) } : {}),
    ...(poly(r.lip) ? { lip: poly(r.lip) } : {}),
    ...(poly(r.eyeL) ? { eyeL: poly(r.eyeL) } : {}),
    ...(poly(r.eyeR) ? { eyeR: poly(r.eyeR) } : {}),
    ...(poly(r.browL) ? { browL: poly(r.browL) } : {}),
    ...(poly(r.browR) ? { browR: poly(r.browR) } : {}),
    ...(poly(r.cheekL) ? { cheekL: poly(r.cheekL) } : {}),
    ...(poly(r.cheekR) ? { cheekR: poly(r.cheekR) } : {}),
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
  ): Promise<LooksResult | undefined> {
    if (!s.lock || !s.skinType || !s.tone || !s.faceImageBase64) {
      errReply(reply, 409, "face analysis and tone must complete before building looks", "not_ready", false);
      return undefined;
    }
    if (s.rendersUsed + 3 > s.rendersBudget) {
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
    const looks = [] as LooksResult["looks"];
    for (const b of built) {
      let imageUrl: string;
      if (usingMock()) {
        // Mock renders composite the real effect list onto the user's own
        // face photo (API contract: imageUrl is a face render, never an
        // abstract color-bar card).
        imageUrl = faceCardDataUrl(b.role, b.effects, input.seed, s.faceImageBase64!, s.landmarks);
      } else {
        // Upload once per session; reuse fileId across renders.
        if (!s.faceFileId) {
          const { fileId } = await uploadFile(cfg.apiKey!, s.faceImageBase64!, cfg.baseUrl);
          s.faceFileId = fileId;
        }
        const res = await runMakeupVto(cfg.apiKey!, s.faceFileId!, b.effects, cfg.baseUrl);
        imageUrl = res.imageUrl;
      }
      looks.push(assembleLook(b, imageUrl));
    }
    s.rendersUsed += 3;
    s.mood = mood;
    s.event = event;
    return {
      sessionId: s.id,
      looks,
      rendersLeft: s.rendersBudget - s.rendersUsed,
      lockApproximated: false,
    };
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
    try {
      const result = await renderLooks(s, body.mood, body.event, s.shuffleCount, reply);
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
    if (s.rendersUsed + 3 > s.rendersBudget) {
      return errReply(reply, 429, "render budget for this session is used up", "budget_exhausted", false);
    }
    s.shuffleCount += 1;
    try {
      const result = await renderLooks(s, s.mood, s.event, s.shuffleCount, reply);
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
