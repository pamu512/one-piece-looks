import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError, EVENTS, MOODS, api, hexToRgb, setLockAccent,
  type Category, type Event, type FaceLandmarksPayload, type FaceResult, type Look, type LooksResult,
  type Mood, type SessionInfo, type Tone,
} from "./lib/types";
import {
  detectFaceOnEncodedPhoto, normalizeTo45, suggestLock, type FaceLandmarks,
} from "./lib/face";
import { loadFaceFrameSession } from "./lib/faceModel";
import { composeShareCard, downloadBlob, shareLooksPng } from "./lib/share";
import { warmDecode } from "./lib/warmDecode";
import { IconChevron, IconSave, IconShare, IconShuffle, IconVibe } from "./components/icons";
import {
  CalmError, FaceGuideOverlay, LockRing, PhaseLine, SampleCanvas, ScanLine, looksLikeSkin, useCamera,
  type SampleCanvasHandle, type SamplePoint,
} from "./components/capture";

/* =================================================================
 * One Piece Looks. Three beats, one persistent face photo.
 *
 * Beat 1  camera: full-bleed mirror, glowing oval guide, one shutter.
 *         A brief scan auto-suggests the lock (zero taps); tap adjusts.
 * Beat 2  lock confirm: ring stamped on the color, pan-shift footnote,
 *         one Build button. Everything else is out of the way.
 * Beat 3  looks are the app: one full-bleed look at a time, horizontal
 *         snap between Anchor/Lift/Statement, floating bar with thumbs,
 *         shuffle, save, share. Vibe lives in a bottom sheet AFTER looks.
 * ================================================================= */

type Stage = "camera" | "photo" | "looks";

const ZONE_TARGETS: { id: Category; label: string; x: number; y: number }[] = [
  { id: "lip", label: "Lip", x: 44.5, y: 70 },
  { id: "cheek", label: "Cheek", x: 30, y: 56 },
  { id: "eye", label: "Eye", x: 38, y: 47 },
  { id: "brow", label: "Brow", x: 38, y: 39.5 },
  { id: "liner", label: "Liner", x: 62, y: 45.5 },
];

const ZONE_WORD: Record<Category, string> = {
  lip: "lip", cheek: "cheek", eye: "eye", brow: "brow", liner: "liner",
};

/** Soft leads: it is the default mood, so it leads the tray. */
const MOODS_ORDERED: readonly Mood[] = (() => {
  const soft = MOODS.find((m) => m === "Soft");
  const rest = MOODS.filter((m) => m !== "Soft");
  return soft ? [soft, ...rest] : rest;
})();

interface LockInfo {
  category: Category;
  onFaceHex: string;
  productHex: string | null;
  unverified: boolean;
  point: SamplePoint;
}

function nearestZone(xPct: number, yPct: number): Category {
  let best: Category = "lip";
  let bestD = Infinity;
  for (const z of ZONE_TARGETS) {
    const d = (0.8 * (z.x - xPct)) ** 2 + (z.y - yPct) ** 2;
    if (d < bestD) { bestD = d; best = z.id; }
  }
  return best;
}

function panShiftSentence(onFace: string, pan: string | null): string {
  if (!pan || pan.toLowerCase() === onFace.toLowerCase())
    return "Building from the color exactly as it sits on your face.";
  const a = hexToRgb(onFace), b = hexToRgb(pan);
  const la = 0.2126 * a.r + 0.7152 * a.g + 0.0722 * a.b;
  const lb = 0.2126 * b.r + 0.7152 * b.g + 0.0722 * b.b;
  const db = b.b - a.b, dl = lb - la;
  let panWord = "a touch different", faceWord = "its own thing on you";
  if (Math.abs(db) >= Math.abs(dl) && Math.abs(db) > 6) {
    panWord = db > 0 ? "cooler" : "warmer";
    faceWord = db > 0 ? "warmer" : "cooler";
  } else if (Math.abs(dl) > 6) {
    panWord = dl > 0 ? "lighter" : "deeper";
    faceWord = dl > 0 ? "deeper" : "lighter";
  }
  return `In the pan it reads ${panWord}; on you it reads ${faceWord}. We build from what's on your face.`;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("camera");
  const [photo, setPhoto] = useState<string | null>(null);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [face, setFace] = useState<FaceResult | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);
  const [landmarks, setLandmarks] = useState<FaceLandmarks | null>(null);

  const [mood, setMood] = useState<Mood>("Soft");
  const [event, setEvent] = useState<Event>("Casual");
  const [looks, setLooks] = useState<LooksResult | null>(null);
  const [builtPair, setBuiltPair] = useState<{ mood: Mood; event: Event } | null>(null);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<{ msg: string; retry?: () => void } | null>(null);
  const [phase, setPhase] = useState<"skin" | "building" | null>(null);

  const faceInFlight = useRef(false);
  const [faceAttempt, setFaceAttempt] = useState(0);

  useEffect(() => { if (lock) setLockAccent(lock.onFaceHex); }, [lock]);

  useEffect(() => {
    if (!session) api.createSession().then(setSession).catch(() => undefined);
  }, [session]);

  // POST /face once a lock exists (idempotent per photo server-side).
  useEffect(() => {
    if (!lock || !session || face || faceInFlight.current) return;
    faceInFlight.current = true;
    setPhase("skin");
    const landmarksPayload: FaceLandmarksPayload | undefined = landmarks
      ? {
          faceBox: landmarks.faceBox,
          lip: landmarks.lip as [number, number][],
          ...(landmarks.lipInner ? { lipInner: landmarks.lipInner as [number, number][] } : {}),
          ...(typeof landmarks.lipMeanL === "number" && Number.isFinite(landmarks.lipMeanL) ? { lipMeanL: landmarks.lipMeanL } : {}),
          ...(typeof landmarks.lipMeanA === "number" && Number.isFinite(landmarks.lipMeanA) ? { lipMeanA: landmarks.lipMeanA } : {}),
          ...(typeof landmarks.lipMeanB === "number" && Number.isFinite(landmarks.lipMeanB) ? { lipMeanB: landmarks.lipMeanB } : {}),
          ...(landmarks.skin ? { skin: landmarks.skin as [number, number][] } : {}),
          eyeL: landmarks.eyeL as [number, number][],
          eyeR: landmarks.eyeR as [number, number][],
          browL: landmarks.browL as [number, number][],
          browR: landmarks.browR as [number, number][],
          cheekL: landmarks.cheekL as [number, number][],
          cheekR: landmarks.cheekR as [number, number][],
        }
      : undefined;
    api.postFace(session.sessionId, photo!.split(",")[1] ?? "", {
      category: lock.category,
      onFaceHex: lock.onFaceHex,
      productHex: lock.productHex ?? lock.onFaceHex,
      unverified: lock.unverified,
    }, landmarksPayload)
      .then((res) => { setFace(res); setPhase(null); })
      .catch((e) => {
        setPhase(null);
        const msg = e instanceof ApiError ? e.message : "Something interrupted the analysis.";
        setError({
          msg,
          retry: () => { setError(null); setFaceAttempt((n) => n + 1); },
        });
      })
      .finally(() => { faceInFlight.current = false; });
  }, [lock, session, face, photo, faceAttempt, landmarks]);

  const restart = () => {
    setStage("camera"); setPhoto(null); setFace(null); setTone(null); setLock(null);
    setLandmarks(null);
    setMood("Soft"); setEvent("Casual"); setLooks(null); setBuiltPair(null);
    setError(null); setPhase(null); setBusy(false);
    setSession(null);
    api.createSession().then(setSession).catch(() => undefined);
  };

  async function buildLooks(m: Mood, e: Event, toneChoice?: { depth: string; temperature: "warm" | "neutral" | "cool" }) {
    if (!session || busy) return;
    setBusy(true); setError(null);
    try {
      if (toneChoice) {
        const res = await api.postTone(session.sessionId, toneChoice.depth, toneChoice.temperature);
        setTone(res.tone);
      }
      setStage("looks"); setPhase("building");
      const res = await api.postLooks(session.sessionId, m, e);
      await warmDecode(res.looks.map((l) => l.imageUrl));
      setLooks(res); setBuiltPair({ mood: m, event: e });
    } catch (err) {
      const msg = err instanceof ApiError ? err.message : "The looks didn't build.";
      setError({ msg, retry: () => { setError(null); void buildLooks(m, e, toneChoice); } });
    } finally { setBusy(false); setPhase(null); }
  }

  async function shuffle() {
    if (!session || busy) return;
    setBusy(true); setError(null);
    try {
      const res = await api.postShuffle(session.sessionId);
      await warmDecode(res.looks.map((l) => l.imageUrl));
      setLooks(res);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Shuffle didn't land.";
      setError({ msg, retry: () => { setError(null); void shuffle(); } });
    } finally { setBusy(false); }
  }

  const pairDirty = builtPair !== null && (builtPair.mood !== mood || builtPair.event !== event);

  return (
    <div className={`app app-${stage}`}>
      {error && (
        <div className="error-float">
          <CalmError msg={error.msg} onRetry={error.retry} onBack={() => setError(null)} />
        </div>
      )}

      {stage === "camera" && (
        <CameraStage
          onPhoto={(p, lm) => {
            setPhoto(p); setLandmarks(lm ?? null); setStage("photo");
          }}
        />
      )}
      {stage === "photo" && photo && (
        <PhotoStage
          photo={photo}
          landmarks={landmarks}
          lock={lock}
          face={face}
          tone={tone}
          onLock={(category, hex, point, unverified) =>
            setLock({ category, onFaceHex: hex, productHex: null, unverified, point })}
          onUpdateProduct={(hex) =>
            setLock((l) => (l ? { ...l, productHex: hex } : l))}
          onRetake={() => {
            setPhoto(null); setLock(null); setFace(null); setTone(null); setLandmarks(null);
            setStage("camera");
          }}
          onBuild={(toneChoice) => void buildLooks(mood, event, toneChoice)}
          busy={busy}
          phase={phase}
        />
      )}
      {stage === "looks" && lock && (
        <LooksStage
          photo={photo}
          looks={looks}
          lock={lock}
          mood={mood} event={event} onMood={setMood} onEvent={setEvent}
          pairDirty={pairDirty}
          onRebuild={() => void buildLooks(mood, event)}
          onShuffle={() => void shuffle()}
          onRestart={restart}
          busy={busy}
        />
      )}
    </div>
  );
}

/* ================= beat 1: full-bleed camera ================= */

function CameraStage({ onPhoto }: { onPhoto: (dataUrl: string, lm: FaceLandmarks | null) => void }) {
  const cam = useCamera();

  useEffect(() => {
    void loadFaceFrameSession();
    void cam.start();
    return () => cam.stop();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const process = useCallback((src: string) => {
    // Normalize to the shared 4:5 frame, detect once (model when its runtime
    // is available, heuristic otherwise), then hand over.
    const img = new Image();
    img.onload = () => {
      const c = normalizeTo45(img);
      const dataUrl = c.toDataURL("image/jpeg", 0.92);
      void detectFaceOnEncodedPhoto(dataUrl, c).then((lm) => onPhoto(dataUrl, lm));
    };
    img.onerror = () => onPhoto(src, null);
    img.src = src;
  }, [onPhoto]);

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => process(String(r.result));
    r.readAsDataURL(f);
  };

  const useSample = () => {
    const src = "fixtures/face-portrait-live.jpg";
    const img = new Image();
    img.onload = () => {
      const c = normalizeTo45(img);
      const dataUrl = c.toDataURL("image/jpeg", 0.92);
      void detectFaceOnEncodedPhoto(dataUrl, c).then((lm) => onPhoto(dataUrl, lm));
    };
    img.onerror = () => onPhoto(src, null);
    img.src = src;
  };

  return (
    <section className="stage stage-camera fade-in" aria-label="Take your photo">
      <div className="camera-media">
        <video ref={cam.videoRef} playsInline muted aria-label="Front camera preview" />
        {cam.state === "live" && <FaceGuideOverlay />}
        {cam.state === "starting" && <p className="cam-note">Starting the camera…</p>}

        {cam.state === "denied" ? (
          <div className="denied">
            <div className="denied-glow" aria-hidden />
            <p className="denied-title display">One piece.<br />Three looks.</p>
            <label className="btn btn-primary btn-big">
              Choose a photo
              <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
            </label>
            <button className="sample-link" onClick={useSample}>
              or try it with a sample face
            </button>
          </div>
        ) : (
          <>
            <p className="cam-hint" aria-hidden>Wear your one piece. Center your face, then shoot.</p>
            <div className="cam-actions">
              <label className="mini-chip">
                <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
                Photo
              </label>
              <button
                className="shutter"
                disabled={cam.state !== "live"}
                onClick={() => { const p = cam.grab(); if (p) process(p); }}
                aria-label="Take the photo"
              >
                <span className="shutter-core" />
              </button>
              <span className="mini-chip ghost" aria-hidden>Smile</span>
            </div>
          </>
        )}
      </div>
      <p className="privacy-once">Photos go to the YouCam service for analysis. We don't keep them.</p>
    </section>
  );
}

/* ================= beat 2: lock + build ================= */

function PhotoStage({
  photo, landmarks, lock, face, tone, onLock, onUpdateProduct, onRetake, onBuild, busy, phase,
}: {
  photo: string;
  landmarks: FaceLandmarks | null;
  lock: LockInfo | null;
  face: FaceResult | null;
  tone: Tone | null;
  onLock: (category: Category, hex: string, point: SamplePoint, unverified: boolean) => void;
  onUpdateProduct: (hex: string) => void;
  onRetake: () => void;
  onBuild: (toneChoice?: { depth: string; temperature: "warm" | "neutral" | "cool" }) => void;
  busy: boolean;
  phase: "skin" | "building" | null;
}) {
  const canvasApi = useRef<SampleCanvasHandle | null>(null);
  const [gate, setGate] = useState<{ hex: string; point: SamplePoint } | null>(null);
  const [showHex, setShowHex] = useState(false);
  const [adjust, setAdjust] = useState(false);
  const [scan, setScan] = useState(true);
  const lockRef = useRef<LockInfo | null>(lock);
  lockRef.current = lock;

  // Auto-suggest: brief scan right after the shutter, ring pre-stamped.
  // StrictMode-safe: the work is idempotent (guarded by lockRef at fire
  // time, not by a state flag set during setup).
  useEffect(() => {
    if (!landmarks) {
      setScan(false);
      return;
    }
    let done = false;
    const finish = () => { if (!done) { done = true; setScan(false); } };
    const t = setTimeout(() => {
      if (lockRef.current) { finish(); return; }
      const c = document.createElement("canvas");
      const img = new Image();
      img.onload = () => {
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0);
        const s = suggestLock(c, landmarks);
        if (s && !looksLikeSkin(s.hex) && !lockRef.current) {
          onLock(s.category, s.hex, s.point, false);
        }
        finish();
      };
      img.onerror = () => finish();
      img.src = photo;
    }, 900);
    return () => { clearTimeout(t); finish(); };
  }, [landmarks, photo, onLock]);

  useEffect(() => {
    if (lock) setScan(false);
  }, [lock]);

  function handleSample(hex: string, pt: SamplePoint) {
    if (!lock || adjust) {
      if (looksLikeSkin(hex)) {
        setGate({ hex, point: pt });
        return;
      }
      setGate(null);
      onLock(nearestZone(pt.xPct, pt.yPct), hex, pt, false);
      setAdjust(false);
      return;
    }
  }

  function handleZoneTap(z: (typeof ZONE_TARGETS)[number]) {
    canvasApi.current?.sampleAt(z.x / 100, z.y / 100);
  }

  const toneNeeded = face?.toneFallback === true && !tone;
  const [depth, setDepth] = useState("03");
  const [temp, setTemp] = useState<"warm" | "neutral" | "cool">("neutral");

  return (
    <section className="stage stage-photo" aria-label="Your locked color">
      <div className="topbar">
        <button className="top-link" onClick={onRetake}>Retake</button>
        <Pips step={1} />
      </div>

      <SampleCanvas ref={canvasApi} src={photo} ariaLabel="Your photo. Tap the color you are wearing to adjust the lock." onSample={handleSample}>
        <ScanLine active={scan} />
        {lock && (
          <LockRing
            point={lock.point} hex={lock.onFaceHex} category={lock.category}
            reveal={showHex} onToggle={() => setShowHex((v) => !v)}
          />
        )}
        {!lock && !scan && (
          <p className="over-hint" aria-hidden>Tap right on the color you're wearing</p>
        )}
        {gate && (
          <div className="gate-line" role="status">
            <p>That reads like skin. Tap again right on the color, or keep it and refine later.</p>
            <button
              className="mini-btn"
              onClick={() => { onLock(nearestZone(gate.point.xPct, gate.point.yPct), gate.hex, gate.point, true); setGate(null); }}
            >
              Keep it
            </button>
          </div>
        )}
      </SampleCanvas>

      {lock ? (
        <div className="lock-dock">
          <p className="pan-shift" role="note">{panShiftSentence(lock.onFaceHex, lock.productHex)}</p>
          <div className="dock-row">
            <button className="mini-btn" onClick={() => setAdjust((v) => !v)} aria-pressed={adjust}>
              {adjust ? "Done" : "Adjust"}
            </button>
            <button
              className="btn btn-primary btn-build"
              disabled={!face || busy}
              onClick={() => onBuild(toneNeeded ? { depth, temperature: temp } : undefined)}
            >
              {busy ? "Building…" : "See my three looks"}
            </button>
          </div>
          {!face && !busy && <p className="phase-inline" role="status">Reading your skin…</p>}
          {toneNeeded && <ToneRamp depth={depth} temp={temp} setDepth={setDepth} setTemp={setTemp} />}
        </div>
      ) : (
        <div className="lock-dock">
          <div className="dock-row">
            {adjust ? null : (
              <button className="mini-btn" onClick={() => setAdjust(true)}>Choose zone</button>
            )}
          </div>
          {adjust && (
            <div className="zone-tray" role="group" aria-label="Adjust the lock zone">
              {ZONE_TARGETS.map((z) => (
                <button key={z.id} className="chip" onClick={() => handleZoneTap(z)}>
                  {z.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      {phase === "skin" && <PhaseLine phase={phase} />}
    </section>
  );
}

function ToneRamp({
  depth, temp, setDepth, setTemp,
}: {
  depth: string; temp: "warm" | "neutral" | "cool";
  setDepth: (d: string) => void; setTemp: (t: "warm" | "neutral" | "cool") => void;
}) {
  const ramp = ["#f6dbc4", "#eec5a4", "#ddab84", "#c28e6b", "#a4714f", "#7d523a"];
  const labels = ["Fairest", "Light", "Medium", "Tan", "Deep", "Rich"];
  return (
    <div className="tone-ramp" role="group" aria-label="Your tone. Pre-filled, adjust if you like.">
      <p className="tone-label">Your tone (a nudge, not a quiz)</p>
      <div className="ramp-row">
        {ramp.map((hex, i) => (
          <button
            key={hex}
            className={`ramp-swatch${depth === String(i + 1).padStart(2, "0") ? " on" : ""}`}
            style={{ background: hex }}
            aria-pressed={depth === String(i + 1).padStart(2, "0")}
            aria-label={labels[i]}
            onClick={() => setDepth(String(i + 1).padStart(2, "0"))}
          />
        ))}
      </div>
      <div className="chip-row" role="group" aria-label="Undertone">
        {(["warm", "neutral", "cool"] as const).map((t) => (
          <button key={t} className="chip chip-s" aria-pressed={temp === t} onClick={() => setTemp(t)}>{t}</button>
        ))}
      </div>
    </div>
  );
}

function Pips({ step }: { step: 0 | 1 | 2 }) {
  return (
    <div className="pips" aria-hidden>
      {[0, 1, 2].map((i) => (
        <span key={i} className={i === step ? "pip on" : "pip"} />
      ))}
    </div>
  );
}

/* ================= beat 3: the looks are the app ================= */

const ROLE_LABEL: Record<Look["role"], string> = { anchor: "Anchor", lift: "Lift", statement: "Statement" };
const ROLE_TAGLINE: Record<Look["role"], string> = {
  anchor: "your piece, nothing else",
  lift: "one step further",
  statement: "the full look",
};

function LooksStage({
  photo, looks, lock, mood, event, onMood, onEvent, pairDirty, onRebuild, onShuffle, onRestart, busy,
}: {
  photo: string | null;
  looks: LooksResult | null;
  lock: LockInfo;
  mood: Mood; event: Event;
  onMood: (m: Mood) => void; onEvent: (e: Event) => void;
  pairDirty: boolean;
  onRebuild: () => void; onShuffle: () => void; onRestart: () => void;
  busy: boolean;
}) {
  const [showHex, setShowHex] = useState(false);
  const [vibeOpen, setVibeOpen] = useState(false);
  const [page, setPage] = useState(0);
  const [bare, setBare] = useState(false);
  const [shareState, setShareState] = useState<"idle" | "working" | "shared" | "downloaded" | "failed">("idle");
  const stripRef = useRef<HTMLDivElement | null>(null);
  const holdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [shuffleKey, setShuffleKey] = useState(0);

  // Track which card is centered (snap) for role pill + dots + thumbnails.
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    const onScroll = () => {
      const i = Math.round(el.scrollLeft / el.clientWidth);
      setPage(Math.max(0, Math.min(2, i)));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, [looks]);

  const goto = (i: number) => {
    const el = stripRef.current;
    if (!el) return;
    // Direct navigation (thumbs, dots) snaps: the user asked for that look,
    // not a ride to it. Physical swipes keep their native momentum.
    el.scrollTo({ left: i * el.clientWidth, behavior: "auto" });
  };

  const startHold = () => { holdTimer.current = setTimeout(() => setBare(true), 260); };
  const endHold = () => {
    if (holdTimer.current) clearTimeout(holdTimer.current);
    setBare(false);
  };

  const current = looks?.looks[page];
  const [shareCard, setShareCard] = useState<{ url: string; blob: Blob } | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const shareShownAt = useRef(0);

  /** Compose once, then show the card visibly (B3: the user sees what ships). */
  const openSharePreview = async () => {
    if (!looks || shareBusy) return;
    setShareBusy(true);
    try {
      const blob = await composeShareCard(
        looks.looks.map((l) => ({ imageUrl: l.imageUrl, role: ROLE_LABEL[l.role] })),
        lock.onFaceHex,
        ZONE_WORD[lock.category],
      );
      setShareCard({ url: URL.createObjectURL(blob), blob });
      shareShownAt.current = Date.now();
    } catch {
      setShareState("failed");
      setTimeout(() => setShareState("idle"), 2200);
    } finally {
      setShareBusy(false);
    }
  };

  const closeSharePreview = () => {
    if (shareCard) {
      URL.revokeObjectURL(shareCard.url);
      setShareCard(null);
    }
  };

  /** Download from the preview. The card has been visible >= the open dwell. */
  const saveFromPreview = () => {
    if (!shareCard) return;
    downloadBlob(shareCard.blob, "one-piece-looks.png");
    setShareState("downloaded");
    setTimeout(() => setShareState("idle"), 2200);
    closeSharePreview();
  };

  /** Share from the preview via the system sheet; falls back to download. */
  const shareFromPreview = async () => {
    if (!shareCard) return;
    const out = await shareLooksPng(shareCard.blob, "One Piece Looks", "My three looks");
    if (out === "cancelled") return; // keep the preview up
    setShareState(out === "shared" ? "shared" : out === "downloaded" ? "downloaded" : "failed");
    setTimeout(() => setShareState("idle"), 2200);
    closeSharePreview();
  };

  // Keyboard escape closes the preview.
  useEffect(() => {
    if (!shareCard) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") closeSharePreview(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shareCard]);

  if (!looks) {
    return (
      <section className="stage stage-looks" aria-label="Building your three looks">
        <div className="camera-media build-fill">
          {photo && <img src={photo} alt="Your photo, dimmed while the looks build" className="dimmed-img" />}
          <div className="build-veil" />
          <p className="build-line" role="status" aria-live="polite">
            <span className="dot-pulse" style={{ background: lock.onFaceHex }} />
            Building your three looks…
          </p>
        </div>
      </section>
    );
  }

  const out = looks.rendersLeft < 3;

  return (
    <section
      className="stage stage-looks"
      aria-label="Your three looks"
      onPointerDown={startHold}
      onPointerUp={endHold}
      onPointerLeave={endHold}
      onPointerCancel={endHold}
    >
      <div className="topbar">
        <button
          type="button"
          className="lock-chip"
          onClick={() => setShowHex((v) => !v)}
          aria-pressed={showHex}
          aria-label={`Locked color. Tap to ${showHex ? "hide" : "show"} the hex.`}
        >
          <span className="dot" style={{ background: lock.onFaceHex }} />
          {showHex ? lock.onFaceHex : `Your ${ZONE_WORD[lock.category]}, kept`}
        </button>
        <Pips step={2} />
        <button className="top-link" onClick={onRestart}>Start over</button>
      </div>

      <div
        ref={stripRef}
        className="look-strip"
        role="region"
        aria-label="Anchor, Lift, and Statement. Swipe or use the thumbnails."
      >
        {looks.looks.map((look, i) => (
          <article key={`${look.role}-${shuffleKey}`} className="look-slide" aria-hidden={page !== i}>
            <div className="look-frame">
              <img
                key={`${look.role}-${shuffleKey}-img`}
                src={look.imageUrl}
                alt={`${ROLE_LABEL[look.role]} look on your face`}
                className={bare ? "bare" : ""}
              />
              {photo && (
                <img src={photo} alt="" aria-hidden className="bare-img" data-on={bare ? "1" : "0"} />
              )}
              {!bare && (
                <span className="role-pill">{ROLE_LABEL[look.role]}</span>
              )}
              {bare && <span className="role-pill ghost-pill">Your face</span>}
            </div>
          </article>
        ))}
      </div>

      <div className="look-meta" aria-live="polite">
        <p className="role-tagline">{ROLE_TAGLINE[(current?.role ?? "anchor") as Look["role"]]}</p>
        <div className="page-dots" aria-hidden>
          {[0, 1, 2].map((i) => (
            <button
              key={i}
              className={i === page ? "pd on" : "pd"}
              onClick={() => goto(i)}
              tabIndex={-1}
              aria-label={`Show ${ROLE_LABEL[(looks.looks[i]?.role ?? "anchor") as Look["role"]]}`}
            />
          ))}
        </div>
        {out && looks.rendersLeft === 0 && (
          <p className="budget-note">That's the full set for this photo.</p>
        )}
        {looks.rendersLeft === 3 && (
          <p className="budget-note">One more shuffle left for this photo.</p>
        )}
      </div>

      <div className="bottom-bar">
        <div className="thumbs">
          {looks.looks.map((l, i) => (
            <button
              key={l.role}
              className={`thumb${i === page ? " on" : ""}`}
              onClick={() => goto(i)}
              aria-label={`Show ${ROLE_LABEL[l.role]}`}
              aria-current={i === page}
            >
              <img src={l.imageUrl} alt="" />
            </button>
          ))}
        </div>
        <div className="bar-actions">
          <button className="icon-btn" onClick={openSharePreview} aria-label="Preview and save the share card" disabled={shareBusy}>
            <IconSave />
          </button>
          <button
            className="icon-btn shuffle-btn"
            onClick={() => { setShuffleKey((k) => k + 1); onShuffle(); }}
            disabled={busy || out}
            aria-label="Shuffle the supporting layers"
          >
            <IconShuffle />
          </button>
          <button className="icon-btn" onClick={openSharePreview} aria-label="Preview and share your three looks" disabled={shareBusy}>
            <IconShare />
          </button>
        </div>
        <button
          className={`vibe-pill${pairDirty ? " dirty" : ""}`}
          onClick={() => setVibeOpen(true)}
        >
          <IconVibe />
          {mood} · {event}
          {pairDirty && <span className="vibe-dot" aria-hidden />}
          <IconChevron size={14} dir="down" />
        </button>
      </div>

      {shareState === "shared" && <div className="toast" role="status">Shared</div>}
      {shareState === "downloaded" && <div className="toast" role="status">Saved to your device</div>}
      {shareState === "failed" && <div className="toast" role="status">Share didn't go through</div>}

      {shareCard && (
        <>
          <div className="sheet-scrim" onClick={closeSharePreview} aria-hidden />
          <div className="sheet share-sheet" role="dialog" aria-label="Your share card">
            <div className="sheet-handle" aria-hidden />
            <p className="sheet-title">Your card</p>
            <img src={shareCard.url} alt="Share card: your three looks with the locked swatch" className="share-preview" />
            <p className="share-note">This is exactly what saves and shares.</p>
            <div className="sheet-actions share-actions">
              <button className="btn btn-ghost" onClick={closeSharePreview}>Back</button>
              <button className="btn btn-ghost" onClick={saveFromPreview}>Save</button>
              <button className="btn btn-primary" onClick={() => void shareFromPreview()}>Share</button>
            </div>
          </div>
        </>
      )}

      {vibeOpen && (
        <>
          <div className="sheet-scrim" onClick={() => setVibeOpen(false)} aria-hidden />
          <div className="sheet" role="dialog" aria-label="Vibe">
            <div className="sheet-handle" aria-hidden />
            <p className="sheet-title">Dress the moment</p>
            {pairDirty && (
              <p className="dirty-note" role="status">
                <span className="vibe-dot" aria-hidden />
                Changed since these looks were built. Rebuild when ready.
              </p>
            )}
            <p className="eyebrow" style={{ margin: "0 0 6px" }}>Mood</p>
            <div className="chip-row vibe-chips" role="group" aria-label="Mood">
              {MOODS_ORDERED.map((m) => (
                <button key={m} className="chip chip-vibe" aria-pressed={mood === m} onClick={() => onMood(m)}>{m}</button>
              ))}
            </div>
            <p className="eyebrow" style={{ margin: "12px 0 6px" }}>Event</p>
            <div className="chip-row vibe-chips" role="group" aria-label="Event">
              {EVENTS.map((e) => (
                <button key={e} className="chip chip-vibe" aria-pressed={event === e} onClick={() => onEvent(e)}>{e}</button>
              ))}
            </div>
            <div className="sheet-actions">
              {pairDirty && (
                <button className="btn btn-primary" onClick={() => { setVibeOpen(false); onRebuild(); }} disabled={busy || out}>
                  {busy ? "Rebuilding…" : "Rebuild"}
                </button>
              )}
              <button className="btn btn-ghost" onClick={() => setVibeOpen(false)}>Done</button>
            </div>
          </div>
        </>
      )}
    </section>
  );
}
