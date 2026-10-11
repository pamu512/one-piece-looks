/**
 * In-memory session store. Sessions live only for the process lifetime and
 * never touch disk: photos are held as base64 only while a session is active
 * and are dropped when the session expires or the process exits.
 */

import { randomUUID } from "node:crypto";
import type {
  Category,
  Lock,
  Mood,
  Event,
  SkinType,
  Tone,
} from "../domain/types.js";

export interface SessionData {
  id: string;
  createdAt: number;
  lastUsedAt: number;
  /** Base64 JPEG of the accepted face photo. Kept in memory only. */
  faceImageBase64?: string;
  lock?: Lock;
  skinType?: SkinType | undefined;
  tone?: Tone | undefined;
  toneFallback: boolean;
  mood?: Mood;
  event?: Event;
  rendersUsed: number;
  rendersBudget: number;
  shuffleCount: number;
  /** Cached YouCam fileId for the face photo (uploads are reusable). */
  faceFileId?: string;
  /** Optional client face landmarks for mock compositing (fractions). */
  landmarks?: import("../youcam/facecard.js").FaceLandmarks | undefined;
  /**
   * Idempotency: the client sends a key per build/shuffle intent; the last
   * completed result for that key is replayed instead of re-rendering, so a
   * lost-response retry cannot double-spend the paid budget.
   */
  lastIdemKey?: string;
  lastIdemResult?: unknown;
}

const TTL_MS = 2 * 60 * 60 * 1000; // 2h; hackathon demo sessions
const MAX_SESSIONS = 200;

export class SessionStore {
  private sessions = new Map<string, SessionData>();
  private sweeper: ReturnType<typeof setInterval> | undefined;

  constructor(ttlMs = TTL_MS) {
    this.ttlMs = ttlMs;
  }

  /**
   * Start the TTL sweeper (review 2026-10-10: the field existed but nothing
   * started it, so expired sessions were only evicted lazily on create()).
   * unref() keeps the timer from holding the process open on shutdown.
   */
  startSweeper(intervalMs = 60_000): void {
    if (this.sweeper) return;
    this.sweeper = setInterval(() => this.sweep(), intervalMs);
    this.sweeper.unref();
  }

  stopSweeper(): void {
    if (this.sweeper) clearInterval(this.sweeper);
    this.sweeper = undefined;
  }

  private readonly ttlMs: number;

  create(rendersBudget: number): SessionData {
    this.sweep();
    while (this.sessions.size >= MAX_SESSIONS) {
      const oldest = [...this.sessions.values()].sort((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (oldest) this.sessions.delete(oldest.id);
    }
    const s: SessionData = {
      id: randomUUID(),
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      toneFallback: false,
      rendersUsed: 0,
      rendersBudget,
      shuffleCount: 0,
    };
    this.sessions.set(s.id, s);
    return s;
  }

  get(id: string): SessionData | undefined {
    const s = this.sessions.get(id);
    if (!s) return undefined;
    if (Date.now() - s.lastUsedAt > this.ttlMs) {
      this.sessions.delete(id);
      return undefined;
    }
    s.lastUsedAt = Date.now();
    return s;
  }

  update(id: string, patch: Partial<SessionData>): SessionData {
    const s = this.get(id);
    if (!s) throw new Error("session not found");
    Object.assign(s, patch);
    s.lastUsedAt = Date.now();
    return s;
  }

  /**
   * Reserve render budget BEFORE any paid call (review 2026-10-10: the old
   * check-then-await let two concurrent /looks both pass against stale
   * state and both render). Returns false when the budget cannot cover it.
   * Roll back with releaseRenders on failure.
   */
  reserveRenders(s: SessionData, n: number): boolean {
    if (s.rendersUsed + n > s.rendersBudget) return false;
    s.rendersUsed += n;
    return true;
  }

  /** Roll back a reservation when the render failed before spending. */
  releaseRenders(s: SessionData, n: number): void {
    s.rendersUsed = Math.max(0, s.rendersUsed - n);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [id, s] of this.sessions) {
      if (now - s.lastUsedAt > this.ttlMs) this.sessions.delete(id);
    }
  }

  /** For tests. */
  get size(): number {
    return this.sessions.size;
  }
}

/** Singleton used by routes. */
export const store = new SessionStore();
