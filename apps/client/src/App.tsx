import { useEffect, useRef, useState } from "react";
import {
  ApiError, EVENTS, MOODS, TONE_DEPTHS, api, hexToRgb, setLockAccent,
  type Category, type Event, type FaceResult, type Look, type LooksResult,
  type Mood, type SessionInfo, type Tone,
} from "./lib/types";
import {
  CalmError, FaceGuideOverlay, LockRing, PhaseLine, SampleCanvas, looksLikeSkin, useCamera,
  type SampleCanvasHandle, type SamplePoint,
} from "./components/capture";

/* =================================================================
 * One Piece Looks. Three beats, one persistent face photo.
 *
 * Beat 1  camera stage: front camera, face guide, one shutter (file
 *         picker stays as a small fallback). The still goes full
 *         screen with five zone targets; one tap sets the category
 *         and samples the on-face hex (the lock).
 * Beat 2  lock stamp + build: ring in the lock hex on the tap point,
 *         one pan-shift sentence, optional pan photo, tone fallback
 *         inline with defaults, mood + event tray, Build button.
 * Beat 3  the three looks are the app: horizontal snap of Anchor,
 *         Lift, Statement renders, shuffle primary, chip tray with
 *         explicit Rebuild, privacy line. No shop catalog.
 * ================================================================= */

type Stage = "camera" | "photo" | "looks";

const ZONE_TARGETS: { id: Category; label: string; x: number; y: number }[] = [
  { id: "lip", label: "Lip", x: 50, y: 71 },
  { id: "cheek", label: "Cheek", x: 30, y: 56 },
  { id: "eye", label: "Eye", x: 38, y: 47 },
  { id: "brow", label: "Brow", x: 38, y: 39.5 },
  { id: "liner", label: "Liner", x: 62, y: 45.5 },
];

const ZONE_WORD: Record<Category, string> = {
  lip: "lip", cheek: "cheek", eye: "eye", brow: "brow", liner: "liner",
};

const NEAR_IDENTICAL = 42;

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
    // aspect-weighted distance (stage is 3:4, so x% covers less px than y%)
    const d = (0.75 * (z.x - xPct)) ** 2 + (z.y - yPct) ** 2;
    if (d < bestD) { bestD = d; best = z.id; }
  }
  return best;
}

function panShiftSentence(onFace: string, pan: string | null): string {
  if (!pan || pan.toLowerCase() === onFace.toLowerCase())
    return "We're building from the color exactly as it sits on your face.";
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
  return `The pan reads ${panWord}; on you it reads ${faceWord}. We build from what's on your face.`;
}

export default function App() {
  const [stage, setStage] = useState<Stage>("camera");
  const [photo, setPhoto] = useState<string | null>(null);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [face, setFace] = useState<FaceResult | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);

  const [mood, setMood] = useState<Mood>("Soft");
  const [event, setEvent] = useState<Event>("Casual");
  const [looks, setLooks] = useState<LooksResult | null>(null);
  const [builtPair, setBuiltPair] = useState<{ mood: Mood; event: Event } | null>(null);
  const [busy, setBusy] = useState(false);

  const [error, setError] = useState<{ msg: string; retry?: () => void } | null>(null);
  const [phase, setPhase] = useState<"skin" | "building" | null>(null);

  const faceInFlight = useRef(false);
  const [faceAttempt, setFaceAttempt] = useState(0);
  const stageRef = useRef<Stage>("camera");
  useEffect(() => { stageRef.current = stage; }, [stage]);

  useEffect(() => { if (lock) setLockAccent(lock.onFaceHex); }, [lock]);

  useEffect(() => {
    if (!session) api.createSession().then(setSession).catch(() => undefined);
  }, [session]);

  // Beat 2 entry: POST /face the moment a lock exists (idempotent on same photo).
  // Beat 2 entry: POST /face the moment a lock exists (idempotent on the
  // same photo server-side; retry bumps an attempt counter).
  useEffect(() => {
    if (!lock || !session || face || faceInFlight.current) return;
    faceInFlight.current = true;
    setPhase("skin");
    api.postFace(session.sessionId, photo!.split(",")[1] ?? "", {
      category: lock.category,
      onFaceHex: lock.onFaceHex,
      productHex: lock.productHex ?? lock.onFaceHex,
      unverified: lock.unverified,
    })
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
  }, [lock, session, face, photo, faceAttempt]);

  const restart = () => {
    setStage("camera"); setPhoto(null); setFace(null); setTone(null); setLock(null);
    setMood("Soft"); setEvent("Casual"); setLooks(null); setBuiltPair(null);
    setError(null); setPhase(null); setBusy(false);
    setSession(null);
    api.createSession().then(setSession).catch(() => undefined);
  };

  async function sendTone(depth: string, temperature: "warm" | "neutral" | "cool") {
    if (!session || !face) return;
    const res = await api.postTone(session.sessionId, depth, temperature);
    setTone(res.tone);
  }

  async function buildLooks(m: Mood, e: Event, toneChoice?: { depth: string; temperature: "warm" | "neutral" | "cool" }) {
    if (!session || busy) return;
    setBusy(true); setError(null);
    try {
      if (toneChoice) await sendTone(toneChoice.depth, toneChoice.temperature);
      setStage("looks"); setPhase("building");
      const res = await api.postLooks(session.sessionId, m, e);
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
      setLooks(res);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Shuffle didn't land.";
      setError({ msg, retry: () => { setError(null); void shuffle(); } });
    } finally { setBusy(false); }
  }

  const pairDirty = builtPair !== null && (builtPair.mood !== mood || builtPair.event !== event);

  return (
    <div className="shell">
      {error && (
        <div style={{ marginTop: 18 }}>
          <CalmError msg={error.msg} onRetry={error.retry} onBack={() => setError(null)} />
        </div>
      )}

      <main className="grow" style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "12px 0" }}>
        {stage === "camera" && (
          <CameraStage
            onPhoto={(p) => { setPhoto(p); setStage("photo"); }}
          />
        )}
        {stage === "photo" && photo && (
          <PhotoStage
            photo={photo}
            lock={lock}
            face={face}
            tone={tone}
            onLock={(category, hex, point, unverified) =>
              setLock({ category, onFaceHex: hex, productHex: null, unverified, point })}
            onUpdateProduct={(hex) =>
              setLock((l) => (l ? { ...l, productHex: hex } : l))}
            onRetake={() => {
              // New photo = new face: drop the lock and analysis (the
              // session stays; POST /face on a new photo re-runs analysis).
              setPhoto(null); setLock(null); setFace(null); setTone(null);
              setStage("camera");
            }}
            mood={mood} event={event} onMood={setMood} onEvent={setEvent}
            onBuild={(toneChoice) => void buildLooks(mood, event, toneChoice)}
            busy={busy}
          />
        )}
        {stage === "looks" && lock && (
          <LooksStage
            photo={photo}
            looks={looks}
            lock={lock}
            mood={mood} event={event} onMood={setMood} onEvent={setEvent}
            pairDirty={pairDirty}
            onRebuild={() => {
              if (face?.toneFallback && !tone) {
                void buildLooks(mood, event, { depth: "03", temperature: "neutral" });
              } else {
                void buildLooks(mood, event);
              }
            }}
            onShuffle={() => void shuffle()}
            onRestart={restart}
            busy={busy}
          />
        )}
      </main>

      <PhaseLine phase={phase} />
    </div>
  );
}

/* ================= beat 1: camera stage ================= */

function CameraStage({ onPhoto }: { onPhoto: (dataUrl: string) => void }) {
  const cam = useCamera();

  useEffect(() => { void cam.start(); return () => cam.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => onPhoto(String(r.result));
    r.readAsDataURL(f);
  };

  return (
    <section className="fade-in" aria-label="Take your photo">
      <p className="eyebrow" style={{ textAlign: "center", marginBottom: 10 }}>One Piece Looks</p>
      <h1 className="display" style={{ fontSize: 34, textAlign: "center", marginBottom: 14 }}>
        One piece. Three looks.
      </h1>

      <div className="camera-stage">
        <video ref={cam.videoRef} playsInline muted aria-label="Front camera preview" />
        <FaceGuideOverlay />
        {cam.state === "denied" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,.72)", padding: 22, textAlign: "center" }}>
            <div>
              <p style={{ margin: "0 0 12px" }}>Camera unavailable</p>
              <label className="btn btn-primary" style={{ display: "inline-block" }}>
                Choose a photo
                <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </div>
          </div>
        )}
        {cam.state === "live" && (
          <p className="stage-hint" aria-hidden>
            Wear your one piece. Center your face, then shoot.
          </p>
        )}
      </div>

      <div className="row" style={{ marginTop: 14 }}>
        <button
          className="btn btn-primary btn-wide"
          disabled={cam.state !== "live"}
          onClick={() => { const p = cam.grab(); if (p) onPhoto(p); }}
        >
          Take the photo
        </button>
      </div>
      <div style={{ textAlign: "center", marginTop: 10 }}>
        <label className="mini-link" style={{ cursor: "pointer" }}>
          No camera? Choose a photo
          <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>

      <p className="footer-note">Photos go to the YouCam service for analysis. We don't keep them.</p>
    </section>
  );
}

/* ================= beats 1+2: the persistent photo stage ================= */

function PhotoStage({
  photo, lock, face, tone, onLock, onUpdateProduct, onRetake,
  mood, event, onMood, onEvent, onBuild, busy,
}: {
  photo: string;
  lock: LockInfo | null;
  face: FaceResult | null;
  tone: Tone | null;
  onLock: (category: Category, hex: string, point: SamplePoint, unverified: boolean) => void;
  onUpdateProduct: (hex: string) => void;
  onRetake: () => void;
  mood: Mood; event: Event;
  onMood: (m: Mood) => void; onEvent: (e: Event) => void;
  onBuild: (toneChoice?: { depth: string; temperature: "warm" | "neutral" | "cool" }) => void;
  busy: boolean;
}) {
  const canvasApi = useRef<SampleCanvasHandle | null>(null);
  const [gate, setGate] = useState<{ hex: string; point: SamplePoint } | null>(null);
  const [showHex, setShowHex] = useState(false);
  const [pan, setPan] = useState<null | "shoot" | "sample">(null);
  const [panPhoto, setPanPhoto] = useState<string | null>(null);
  const [depth, setDepth] = useState("03");
  const [temp, setTemp] = useState<"warm" | "neutral" | "cool">("neutral");

  const sampling = !lock;

  function handleSample(hex: string, pt: SamplePoint) {
    if (lock) return;
    if (looksLikeSkin(hex)) {
      setGate({ hex, point: pt });
      return;
    }
    setGate(null);
    onLock(nearestZone(pt.xPct, pt.yPct), hex, pt, false);
  }

  function handleZoneTap(z: (typeof ZONE_TARGETS)[number]) {
    if (lock) return;
    // Sample at the canonical zone point on the photo.
    canvasApi.current?.sampleAt(z.x / 100, z.y / 100);
  }

  /* ---------- beat 1: sampling view ---------- */

  if (sampling) {
    return (
      <section className="fade-in" aria-label="Tap where you wore it">
        <div className="stage-head">
          <button className="mini-link" onClick={onRetake} aria-label="Retake the photo">Retake</button>
          <p className="eyebrow" style={{ margin: 0 }}>Step 1 of 2</p>
        </div>

        <SampleCanvas ref={canvasApi} src={photo} ariaLabel="Your photo. Tap where you are wearing the piece." onSample={handleSample}>
          {ZONE_TARGETS.map((z) => (
            <button
              key={z.id}
              type="button"
              className="zone-dot"
              style={{ left: `${z.x}%`, top: `${z.y}%` }}
              onClick={(e) => { e.stopPropagation(); handleZoneTap(z); }}
              aria-label={`${z.label} zone. Samples the color at the ${z.label.toLowerCase()}.`}
            >
              <span className="zone-dot-ring" />
              <span className="zone-dot-label">{z.label}</span>
            </button>
          ))}
          <p className="stage-hint" aria-hidden>Tap where you're wearing it. One tap reads the color and locks it.</p>
          {gate && (
            <div className="gate-line" role="status">
              <p>
                That tap reads like skin, not product color. Tap again right on the color,
                or continue and we'll mark it unverified.
              </p>
              <button
                className="mini-btn"
                onClick={() => { onLock(nearestZone(gate.point.xPct, gate.point.yPct), gate.hex, gate.point, true); setGate(null); }}
              >
                Continue with this color
              </button>
            </div>
          )}
        </SampleCanvas>
      </section>
    );
  }

  /* ---------- pan sub-capture (same stage) ---------- */

  if (pan === "shoot") {
    return (
      <PanCapture
        onShot={(p) => { setPanPhoto(p); setPan("sample"); }}
        onCancel={() => setPan(null)}
      />
    );
  }
  if (pan === "sample" && panPhoto) {
    return (
      <section className="fade-in" aria-label="Sample the pan color">
        <div className="stage-head">
          <button className="mini-link" onClick={() => setPan(null)}>Cancel</button>
          <p className="eyebrow" style={{ margin: 0 }}>The pan</p>
        </div>
        <SampleCanvas
          src={panPhoto}
          ariaLabel="Pan photo. Tap the heart of the color, not the edge."
          onSample={(hex) => { onUpdateProduct(hex); setPan(null); }}
        >
          <p className="stage-hint" aria-hidden>Tap the heart of the color, not the edge.</p>
        </SampleCanvas>
      </section>
    );
  }

  /* ---------- beat 2: locked view ---------- */

  const toneNeeded = face?.toneFallback && !tone;

  return (
    <section className="fade-in" aria-label="Your locked color and the build tray">
      <div className="stage-head">
        <button className="mini-link" onClick={onRetake} aria-label="Retake the photo">Retake</button>
        <p className="eyebrow" style={{ margin: 0 }}>Step 2 of 2</p>
      </div>

      <SampleCanvas src={photo} ariaLabel="Your photo with the locked color" onSample={() => undefined} disabled>
        <LockRing
          point={lock.point} hex={lock.onFaceHex} category={lock.category}
          reveal={showHex} onToggle={() => setShowHex((v) => !v)}
        />
        {lock.unverified && <span className="unverified-tag">unverified sample</span>}
      </SampleCanvas>

      <p className="pan-shift" role="note">{panShiftSentence(lock.onFaceHex, lock.productHex)}</p>

      {!lock.productHex ? (
        <div className="row" style={{ marginTop: 10, flexWrap: "wrap", gap: 8 }}>
          <button className="mini-btn" onClick={() => setPan("shoot")}>Photograph the pan</button>
          <button className="mini-btn" onClick={() => onUpdateProduct(lock.onFaceHex)}>
            Skip, use what is on my face
          </button>
        </div>
      ) : (
        <div className="row" style={{ marginTop: 10, gap: 8 }}>
          <span className="recipe-chip"><span className="dot" style={{ background: lock.productHex }} />pan color set</span>
          <button className="mini-link" onClick={() => setPan("shoot")}>Re-shoot the pan</button>
        </div>
      )}

      {toneNeeded && (
        <div className="card" style={{ marginTop: 14 }}>
          <p style={{ margin: "0 0 8px", fontWeight: 650, fontSize: 14.5 }}>Your tone (pre-filled, adjust if you like)</p>
          <div className="chip-row" role="group" aria-label="Tone depth">
            {TONE_DEPTHS.map((d) => (
              <button key={d} className="chip" aria-pressed={depth === d} onClick={() => setDepth(d)}>{d}</button>
            ))}
          </div>
          <div className="chip-row" role="group" aria-label="Tone temperature" style={{ marginTop: 8 }}>
            {(["warm", "neutral", "cool"] as const).map((t) => (
              <button key={t} className="chip" aria-pressed={temp === t} onClick={() => setTemp(t)}>{t}</button>
            ))}
          </div>
        </div>
      )}

      <MoodEventTray mood={mood} event={event} onMood={onMood} onEvent={onEvent} />

      <div className="row" style={{ marginTop: 16 }}>
        <button
          className="btn btn-primary btn-wide"
          disabled={!face || busy}
          onClick={() => onBuild(toneNeeded ? { depth, temperature: temp } : undefined)}
        >
          {busy ? "Building…" : "Build my three looks"}
        </button>
      </div>
      {!face && <p className="dim" style={{ fontSize: 12.5, textAlign: "center", margin: "8px 0 0" }}>Reading your skin type…</p>}
    </section>
  );
}

/* ---------- pan capture (camera again, small) ---------- */

function PanCapture({ onShot, onCancel }: { onShot: (dataUrl: string) => void; onCancel: () => void }) {
  const cam = useCamera();
  useEffect(() => { void cam.start(); return () => cam.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => onShot(String(r.result));
    r.readAsDataURL(f);
  };

  return (
    <section className="fade-in" aria-label="Photograph the pan">
      <div className="stage-head">
        <button className="mini-link" onClick={onCancel}>Back</button>
        <p className="eyebrow" style={{ margin: 0 }}>The pan</p>
      </div>
      <div className="camera-stage">
        <video ref={cam.videoRef} playsInline muted aria-label="Camera preview for the product pan" />
        {cam.state === "denied" && (
          <div style={{ position: "absolute", inset: 0, display: "grid", placeItems: "center", background: "rgba(0,0,0,.72)", padding: 22, textAlign: "center" }}>
            <div>
              <p style={{ margin: "0 0 12px" }}>Camera unavailable</p>
              <label className="btn btn-primary" style={{ display: "inline-block" }}>
                Choose a photo
                <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
              </label>
            </div>
          </div>
        )}
        <p className="stage-hint" aria-hidden>Fill the frame with the color. Plain background, no glare.</p>
      </div>
      <div className="row" style={{ marginTop: 14 }}>
        <button className="btn btn-primary btn-wide" disabled={cam.state !== "live"} onClick={() => { const p = cam.grab(); if (p) onShot(p); }}>
          Photograph the pan
        </button>
      </div>
      <div style={{ textAlign: "center", marginTop: 10 }}>
        <label className="mini-link" style={{ cursor: "pointer" }}>
          No camera? Choose a photo
          <input type="file" accept="image/*" hidden onChange={(e) => onFile(e.target.files?.[0])} />
        </label>
      </div>
    </section>
  );
}

/* ---------- mood + event tray (shared) ---------- */

function MoodEventTray({
  mood, event, onMood, onEvent, title = true,
}: {
  mood: Mood; event: Event;
  onMood: (m: Mood) => void; onEvent: (e: Event) => void;
  title?: boolean;
}) {
  return (
    <div className="tray" style={{ marginTop: 14 }} aria-label="Mood and event">
      {title && <p className="eyebrow" style={{ margin: "0 0 8px" }}>Dress the moment</p>}
      <p className="eyebrow" style={{ margin: "0 0 6px", fontSize: 10 }}>Mood</p>
      <div className="chip-row" role="group" aria-label="Mood">
        {MOODS.map((m) => (
          <button key={m} className="chip" aria-pressed={mood === m} onClick={() => onMood(m)}>{m}</button>
        ))}
      </div>
      <p className="eyebrow" style={{ margin: "10px 0 6px", fontSize: 10 }}>Event</p>
      <div className="chip-row" role="group" aria-label="Event">
        {EVENTS.map((e) => (
          <button key={e} className="chip" aria-pressed={event === e} onClick={() => onEvent(e)}>{e}</button>
        ))}
      </div>
    </div>
  );
}

/* ================= beat 3: the looks are the app ================= */

const ROLE_LABEL: Record<Look["role"], string> = { anchor: "Anchor", lift: "Lift", statement: "Statement" };

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
  if (!looks) {
    // Loading: dimmed face + lock chip, never blank skeletons only.
    return (
      <section aria-label="Building your three looks" className="fade-in">
        <div className="camera-stage dimmed">
          {photo && <img src={photo} alt="Your photo, dimmed while we build" />}
          <div className="lock-chip build-chip"><span className="dot" style={{ background: lock.onFaceHex }} />Building your three looks…</div>
        </div>
      </section>
    );
  }

  const out = looks.rendersLeft < 3;

  return (
    <section aria-label="Your three looks">
      <div className="row" style={{ marginBottom: 12 }}>
        <div className="grow">
          <p className="eyebrow" style={{ margin: 0 }}>Your three looks</p>
          <h2 className="display" style={{ fontSize: 30, margin: 0 }}>Built around your {ZONE_WORD[lock.category]}</h2>
        </div>
        <button
          type="button"
          className="lock-chip"
          style={{ border: "none", font: "inherit", cursor: "pointer" }}
          onClick={() => setShowHex((v) => !v)}
          aria-pressed={showHex}
          aria-label={`Locked color. Tap to ${showHex ? "hide" : "show"} the hex.`}
        >
          <span className="dot" style={{ background: lock.onFaceHex }} />
          {showHex ? lock.onFaceHex : `Locked ${ZONE_WORD[lock.category]}`}
        </button>
      </div>

      {looks.lockApproximated && (
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>Your shade reads closest to this.</p>
      )}

      <div className="looks-strip" role="list" aria-label="Anchor, Lift, and Statement">
        {looks.looks.map((look) => (
          <LookCard key={look.role} look={look} lockPoint={lock.point} lockHex={lock.onFaceHex} lockCategory={lock.category} />
        ))}
      </div>

      <div className="row" style={{ marginTop: 16, flexWrap: "wrap", gap: 10 }}>
        <button className="btn btn-primary" onClick={onShuffle} disabled={busy || out}>
          {busy ? "Shuffling…" : out ? "No renders left" : "Shuffle"}
        </button>
        {pairDirty && (
          <button className="btn btn-ghost" onClick={onRebuild} disabled={busy || out}>
            Rebuild for {mood} × {event}
          </button>
        )}
        <button className="btn btn-ghost" onClick={onRestart} disabled={busy}>Start over</button>
      </div>

      <div className="tray" style={{ marginTop: 14 }}>
        <div className="row" style={{ justifyContent: "space-between" }}>
          <p className="eyebrow" style={{ margin: 0 }}>Mood + event</p>
          <span className="renders-pill">{looks.rendersLeft} render{looks.rendersLeft === 1 ? "" : "s"} left</span>
        </div>
        <div className="chip-row" role="group" aria-label="Mood" style={{ marginTop: 8 }}>
          {MOODS.map((m) => (
            <button key={m} className="chip" aria-pressed={mood === m} onClick={() => onMood(m)}>{m}</button>
          ))}
        </div>
        <div className="chip-row" role="group" aria-label="Event" style={{ marginTop: 8 }}>
          {EVENTS.map((e) => (
            <button key={e} className="chip" aria-pressed={event === e} onClick={() => onEvent(e)}>{e}</button>
          ))}
        </div>
      </div>

      <p className="footer-note">Photos go to the YouCam service for analysis. We don't keep them.</p>
    </section>
  );
}

function ShareButton({ imageUrl, role }: { imageUrl: string; role: string }) {
  const [canShare, setCanShare] = useState(false);
  const [shared, setShared] = useState(false);
  useEffect(() => {
    setCanShare(typeof navigator !== "undefined" && typeof navigator.share === "function");
  }, []);
  if (!canShare) return null;
  return (
    <button
      className="mini-btn"
      onClick={() => {
        const data: ShareData = { title: `One Piece Looks - ${ROLE_LABEL[role as Look["role"]]}`, text: "My three looks" };
        if (!imageUrl.startsWith("data:")) data.url = imageUrl;
        navigator.share?.(data).then(() => {
          setShared(true);
          setTimeout(() => setShared(false), 2000);
        }).catch(() => undefined);
      }}
      aria-label={`Share the ${ROLE_LABEL[role as Look["role"]]} look`}
    >
      {shared ? "Shared" : "Share"}
    </button>
  );
}

function LookCard({
  look, lockPoint, lockHex, lockCategory,
}: {
  look: Look;
  lockPoint: SamplePoint;
  lockHex: string;
  lockCategory: Category;
}) {
  const [saved, setSaved] = useState(false);

  async function save() {
    try {
      const url = look.imageUrl;
      const a = document.createElement("a");
      if (url.startsWith("data:")) {
        a.href = url;
      } else {
        const blob = await fetch(url).then((r) => r.blob());
        a.href = URL.createObjectURL(blob);
      }
      a.download = `one-piece-${look.role}.jpg`;
      a.click();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch {
      window.open(look.imageUrl, "_blank", "noopener");
    }
  }

  return (
    <article className="look-card fade-in" role="listitem">
      <div className="img-wrap">
        <img src={look.imageUrl} alt={`${ROLE_LABEL[look.role]} look on your face`} />
        <span className="role-tag">{ROLE_LABEL[look.role]}</span>
        <span
          className="lock-ring compact"
          style={{ left: `${lockPoint.xPct}%`, top: `${lockPoint.yPct}%` }}
          aria-label={`${lockCategory} locked at this spot, color ${lockHex}`}
          title={`${lockCategory} locked · ${lockHex}`}
        />
      </div>
      <div className="look-head">
        <h3 className="display" style={{ fontSize: 20, margin: 0, flexGrow: 1 }}>{ROLE_LABEL[look.role]}</h3>
        {look.lockApproximated && <span className="recipe-chip">nearest shade</span>}
        <ShareButton imageUrl={look.imageUrl} role={look.role} />
        <button className="mini-btn" onClick={() => void save()} aria-label={`Save the ${ROLE_LABEL[look.role]} render`}>
          {saved ? "Saved" : "Save"}
        </button>
      </div>
      <div className="look-chips">
        {look.chips.map((c, i) => (
          <span key={`${look.role}-${i}`} className="recipe-chip">
            <span className="dot" style={{ background: c.hex }} />
            {c.label}{c.detail ? ` · ${c.detail}` : ""}
          </span>
        ))}
      </div>
    </article>
  );
}
