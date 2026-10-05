import { useEffect, useMemo, useState } from "react";
import {
  ApiError, CATEGORIES, EVENTS, MOODS, api, colorDistance, setLockAccent,
  type Category, type Event, type FaceResult, type Look, type LooksResult, type Mood, type SessionInfo, type SkinType, type Tone,
} from "./lib/types";
import {
  CalmError, FACE_GUIDE, GuideOverlay, PHASE_COPY, PRODUCT_GUIDE, PhaseLine,
  TapSampleStage, faceGate, useCamera,
} from "./components/capture";

type Step = 0 | 1 | 2 | 3 | 4 | 5; // start..looks

interface LockInfo {
  category: Category;
  productHex: string;
  onFaceHex: string;
  unverified: boolean;
}

const NEAR_IDENTICAL = 42; // color distance under which we say "true to the pan"

export default function App() {
  const [step, setStep] = useState<Step>(0);
  const [category, setCategory] = useState<Category | null>(null);

  const [session, setSession] = useState<SessionInfo | null>(null);
  const [face, setFace] = useState<FaceResult | null>(null);
  const [tone, setTone] = useState<Tone | null>(null);
  const [lock, setLock] = useState<LockInfo | null>(null);

  const [mood, setMood] = useState<Mood | null>(null);
  const [event, setEvent] = useState<Event | null>(null);
  const [looks, setLooks] = useState<LooksResult | null>(null);
  const [looksLoading, setLooksLoading] = useState(false);

  const [error, setError] = useState<{ msg: string; retry?: () => void } | null>(null);
  const [phase, setPhase] = useState<keyof typeof PHASE_COPY | null>(null);

  useEffect(() => { if (lock) setLockAccent(lock.onFaceHex); }, [lock]);

  useEffect(() => {
    if (!session) api.createSession().then(setSession).catch(() => undefined);
  }, [session]);

  const restart = () => {
    setStep(0); setCategory(null); setFace(null); setTone(null); setLock(null);
    setMood(null); setEvent(null); setLooks(null); setError(null); setPhase(null);
    setSession(null);
    api.createSession().then(setSession).catch(() => undefined);
  };

  return (
    <div className="shell">
      <div className="steps" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <i key={i} className={step === i ? "on" : ""} />
        ))}
      </div>

      {error && (
        <div style={{ marginTop: 18 }}>
          <CalmError msg={error.msg} onRetry={error.retry} onBack={() => setError(null)} />
        </div>
      )}

      <main className="grow" style={{ display: "flex", flexDirection: "column", justifyContent: "center", padding: "18px 0" }}>
        {step === 0 && (
          <StartScreen onPick={(c) => { setCategory(c); setStep(1); }} />
        )}
        {step === 1 && category && (
          <ProductCapture
            category={category}
            onDone={(hex) => { setLock({ category, productHex: hex, onFaceHex: "", unverified: false }); setStep(2); }}
            onBack={() => setStep(0)}
          />
        )}
        {step === 2 && category && (
          <FaceCapture
            category={category}
            onDone={(onFaceHex, unverified, skinRef) => {
              setLock((l) => l ? { ...l, onFaceHex, unverified } : l);
              void runFace(onFaceHex, unverified, skinRef);
            }}
            onBack={() => setStep(1)}
            existing={lock}
          />
        )}
        {step === 3 && lock && face && (
          <ShiftScreen
            lock={lock} face={face} tone={tone}
            onTonePicked={(t) => setTone(t)}
            onNext={() => setStep(4)}
          />
        )}
        {step === 4 && (
          <MoodEventScreen
            mood={mood} event={event}
            onMood={setMood} onEvent={setEvent}
            onBuild={() => void buildLooks()}
            loading={looksLoading}
          />
        )}
        {step === 5 && looks && lock && (
          <LooksScreen
            looks={looks} lockHex={lock.onFaceHex} category={lock.category}
            onShuffle={() => void shuffle()}
            onChange={() => { setStep(4); }}
            onRestart={restart}
            busy={looksLoading}
          />
        )}
        {step === 5 && !looks && lock && (
          <section aria-label="Building your three looks" className="fade-in">
            <div className="row" style={{ marginBottom: 14 }}>
              <div className="grow">
                <p className="eyebrow" style={{ margin: 0 }}>Your three looks</p>
                <h2 className="display" style={{ fontSize: 30, margin: 0 }}>Built around your {lock.category}</h2>
              </div>
              <span className="lock-chip"><span className="dot" style={{ background: lock.onFaceHex }} />{lock.onFaceHex}</span>
            </div>
            <div style={{ display: "grid", gap: 16 }}>
              {(["anchor", "lift", "statement"] as const).map((role) => (
                <article key={role} className="look-card" aria-hidden>
                  <div className="img-wrap">
                    <div className="skel" style={{ position: "absolute", inset: 0 }} />
                  </div>
                  <div className="look-head">
                    <h3 className="display" style={{ fontSize: 22, margin: 0 }}>{role === "anchor" ? "Anchor" : role === "lift" ? "Lift" : "Statement"}</h3>
                    <span className="recipe-chip"><span className="dot" style={{ background: lock.onFaceHex }} />locked</span>
                  </div>
                </article>
              ))}
            </div>
          </section>
        )}
      </main>

      <PhaseLine phase={phase} />
    </div>
  );

  async function runFace(onFaceHex: string, unverified: boolean, _skinRef: string | null) {
    if (!session || !category) return;
    const photo = sessionStorage.getItem("opl:facePhoto") ?? "";
    const productHex = sessionStorage.getItem("opl:productHex") ?? onFaceHex;
    setPhase("skin");
    try {
      const res = await api.postFace(session.sessionId, photo.split(",")[1] ?? "", {
        category, onFaceHex, productHex, unverified,
      });
      setFace(res);
      setLock({ category, productHex, onFaceHex, unverified });
      setPhase(null);
      setStep(3);
    } catch (e) {
      setPhase(null);
      const msg = e instanceof ApiError ? e.message : "Something interrupted the analysis.";
      setError({ msg, retry: () => { setError(null); void runFace(onFaceHex, unverified, _skinRef); } });
      // still allow moving to Shift with unverified data if retry keeps failing? No — calm card only.
    }
  }

  async function buildLooks() {
    if (!session || !mood || !event) return;
    setLooksLoading(true);
    setPhase("building");
    setStep(5);
    try {
      const res = await api.postLooks(session.sessionId, mood, event);
      setLooks(res);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "The looks didn’t build.";
      setError({ msg, retry: () => { setError(null); void buildLooks(); } });
    } finally {
      setLooksLoading(false);
      setPhase(null);
    }
  }

  async function shuffle() {
    if (!session) return;
    setLooksLoading(true);
    try {
      const res = await api.postShuffle(session.sessionId);
      setLooks(res);
    } catch (e) {
      const msg = e instanceof ApiError ? e.message : "Shuffle didn’t land.";
      setError({ msg, retry: () => { setError(null); void shuffle(); } });
    } finally { setLooksLoading(false); }
  }
}

/* ================= screen 1: start ================= */

function StartScreen({ onPick }: { onPick: (c: Category) => void }) {
  return (
    <section className="fade-in" aria-label="Choose your piece">
      <p className="eyebrow">One Piece Looks</p>
      <h1 className="display" style={{ fontSize: 44 }}>One piece.<br />Three looks.</h1>
      <p className="muted" style={{ marginTop: 12, marginBottom: 26, maxWidth: "38ch" }}>
        Start with the one product you’re wearing. We read how it sits on you, then build three finished looks around it.
      </p>
      <div role="list" style={{ display: "grid", gap: 10 }}>
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            role="listitem"
            className="btn btn-ghost"
            style={{ display: "flex", justifyContent: "space-between", alignItems: "center", borderRadius: 16, padding: "16px 18px" }}
            onClick={() => onPick(c.id)}
          >
            <span style={{ textAlign: "left" }}>
              <span style={{ display: "block", fontWeight: 650 }}>{c.label}</span>
              <span className="dim" style={{ fontSize: 13 }}>{c.blurb}</span>
            </span>
            <span aria-hidden style={{ color: "var(--ink-3)" }}>→</span>
          </button>
        ))}
      </div>
      <p className="footer-note">Photos go to the YouCam service for analysis. We don’t keep them.</p>
    </section>
  );
}

/* ================= screen 2: product capture ================= */

function ProductCapture({
  category, onDone, onBack,
}: { category: Category; onDone: (hex: string) => void; onBack: () => void }) {
  const cam = useCamera();
  const [photo, setPhoto] = useState<string | null>(null);
  const [hex, setHex] = useState<string | null>(null);
  const [mark, setMark] = useState<{ x: number; y: number } | null>(null);
  const guide = PRODUCT_GUIDE[category];

  useEffect(() => { void cam.start(); return () => cam.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setPhoto(String(r.result));
    r.readAsDataURL(f);
  };

  return (
    <section className="fade-in" aria-label="Photograph the product">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn btn-ghost" onClick={onBack} aria-label="Back to categories">←</button>
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>Step 1 of 3 · {category}</p>
          <h2 className="display" style={{ fontSize: 28, margin: 0 }}>The piece itself</h2>
        </div>
      </div>

      {!photo && (
        <>
          <div className="camera-stage">
            <video ref={cam.videoRef} playsInline muted aria-label="Camera preview for product photo" />
            <GuideOverlay kind={guide.shape} />
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
          </div>
          <ul className="muted" style={{ margin: "16px 0 18px", paddingLeft: 20, fontSize: 14.5 }}>
            {guide.lines.map((l: string) => <li key={l} style={{ marginBottom: 4 }}>{l}</li>)}
          </ul>
          <div className="row">
            <button className="btn btn-primary btn-wide" disabled={cam.state !== "live"} onClick={() => setPhoto(cam.grab())}>
              Capture
            </button>
          </div>
        </>
      )}

      {photo && !hex && (
        <>
          <TapSampleStage
            photoDataUrl={photo}
            zoneHint="Tap the color — the heart of it, not the edge"
            sampleMark={mark}
            onSample={(h: string, _ctx: CanvasRenderingContext2D, pt: { x: number; y: number }) => { setHex(h); setMark(pt); }}
          />
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => { setPhoto(null); setMark(null); void cam.start(); }}>Retake</button>
            <span className="grow" />
            <label className="btn btn-ghost" style={{ cursor: "pointer" }}>
              Use a file
              <input type="file" accept="image/*" hidden onChange={(e) => { setHex(null); onFile(e.target.files?.[0]); }} />
            </label>
          </div>
        </>
      )}

      {photo && hex && (
        <div className="fade-in">
          <div className="card row" style={{ gap: 16 }}>
            <span style={{ width: 64, height: 64, borderRadius: 14, background: hex, border: "1px solid var(--line-strong)", flexShrink: 0 }} />
            <div className="grow">
              <p style={{ margin: 0, fontWeight: 650 }}>This is your piece?</p>
              <p className="dim" style={{ margin: "2px 0 0", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 }}>{hex}</p>
            </div>
          </div>
          <div className="row" style={{ marginTop: 16 }}>
            <button className="btn btn-ghost" onClick={() => setHex(null)}>Re-tap</button>
            <span className="grow" />
            <button
              className="btn btn-primary"
              onClick={() => {
                sessionStorage.setItem("opl:productHex", hex);
                sessionStorage.setItem("opl:productPhoto", photo);
                onDone(hex);
              }}
            >
              Looks right
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

/* ================= screen 3: face capture ================= */

function FaceCapture({
  category, onDone, onBack, existing,
}: {
  category: Category;
  onDone: (onFaceHex: string, unverified: boolean, skinRefHex: string | null) => void;
  onBack: () => void;
  existing: LockInfo | null;
}) {
  const cam = useCamera();
  const [photo, setPhoto] = useState<string | null>(null);
  const [hex, setHex] = useState<string | null>(null);
  const [mark, setMark] = useState<{ x: number; y: number } | null>(null);
  const [skinRef, setSkinRef] = useState<string | null>(null);
  const [nudges, setNudges] = useState(0);
  const [gate, setGate] = useState<{ reason: string; fix: string } | null>(null);
  const guide = FACE_GUIDE[category];

  useEffect(() => { void cam.start(); return () => cam.stop(); }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const onFile = (f: File | undefined) => {
    if (!f) return;
    const r = new FileReader();
    r.onload = () => setPhoto(String(r.result));
    r.readAsDataURL(f);
  };

  // first tap = worn-zone sample; second tap (optional) = clean skin reference for the gate
  function handleSample(h: string, _ctx: CanvasRenderingContext2D, pt: { x: number; y: number }) {
    if (!hex) { setHex(h); setMark(pt); setGate(null); return; }
    setSkinRef(h);
    const g = faceGate(category, hex, h);
    setGate(g);
  }

  const nudged = gate && nudges < 3;

  return (
    <section className="fade-in" aria-label="Wear it, then shoot">
      <div className="row" style={{ marginBottom: 14 }}>
        <button className="btn btn-ghost" onClick={onBack} aria-label="Back to product photo">←</button>
        <div>
          <p className="eyebrow" style={{ margin: 0 }}>Step 2 of 3 · {category}</p>
          <h2 className="display" style={{ fontSize: 28, margin: 0 }}>Wear it, then shoot</h2>
        </div>
      </div>

      {!photo && (
        <>
          <div className="camera-stage">
            <video ref={cam.videoRef} playsInline muted aria-label="Camera preview for face photo" />
            <GuideOverlay kind="face" />
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
          </div>
          <ul className="muted" style={{ margin: "16px 0 18px", paddingLeft: 20, fontSize: 14.5 }}>
            {guide.lines.map((l: string) => <li key={l} style={{ marginBottom: 4 }}>{l}</li>)}
          </ul>
          <button className="btn btn-primary btn-wide" disabled={cam.state !== "live"} onClick={() => setPhoto(cam.grab())}>
            Capture
          </button>
        </>
      )}

      {photo && !hex && (
        <>
          <TapSampleStage
            photoDataUrl={photo}
            zoneHint={guide.zone}
            sampleMark={mark}
            onSample={handleSample}
          />
          <p className="muted" style={{ fontSize: 14, marginTop: 12, marginBottom: 0, textAlign: "center" }}>
            Tap where you wore it. We’ll read the color from there.
          </p>
        </>
      )}

      {photo && hex && (
        <div className="fade-in">
          <div className="card">
            <div className="row" style={{ gap: 14 }}>
              <span style={{ width: 56, height: 56, borderRadius: 12, background: hex, border: "1px solid var(--line-strong)", flexShrink: 0 }} />
              <div className="grow">
                <p style={{ margin: 0, fontWeight: 650 }}>On your face</p>
                <p className="dim" style={{ margin: "2px 0 0", fontFamily: "ui-monospace, Menlo, monospace", fontSize: 12.5 }}>{hex}</p>
              </div>
            </div>
            {!skinRef && (
              <p className="muted" style={{ fontSize: 13.5, margin: "12px 0 0" }}>
                One more tap: on plain skin beside it (cheek or jaw). It calibrates the read — two taps total.
              </p>
            )}
          </div>

          {nudged && gate && (
            <div className="calm-card" style={{ marginTop: 12 }} role="status">
              <p style={{ margin: "0 0 2px", fontWeight: 600 }}>{gate.reason}</p>
              <p className="muted" style={{ margin: 0, fontSize: 14 }}>If you can, {gate.fix}.</p>
            </div>
          )}

          <div className="row" style={{ marginTop: 16, flexWrap: "wrap" }}>
            {gate && nudges < 3 && (
              <button
                className="btn btn-ghost"
                onClick={() => { setNudges((n) => n + 1); setHex(null); setMark(null); setSkinRef(null); setGate(null); }}
              >
                Retake ({3 - nudges} left)
              </button>
            )}
            {gate && nudges >= 3 && (
              <button
                className="btn btn-ghost"
                onClick={() => onDone(hex, true, skinRef)}
              >
                Continue anyway
              </button>
            )}
            {!gate && (
              <button
                className="btn btn-primary"
                onClick={() => {
                  sessionStorage.setItem("opl:facePhoto", photo);
                  onDone(hex, existing?.unverified ?? false, skinRef);
                }}
              >
                Looks right
              </button>
            )}
            <span className="grow" />
            <button className="btn btn-ghost" onClick={() => { setHex(null); setMark(null); setSkinRef(null); setGate(null); }}>
              Re-tap
            </button>
          </div>
          {gate && nudges >= 3 && (
            <p className="dim" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
              Continuing marks the sample unverified — that’s fine, we’ll still build from it.
            </p>
          )}
        </div>
      )}
    </section>
  );
}

/* ================= screen 4: the shift ================= */

function ShiftScreen({
  lock, face, tone, onTonePicked, onNext,
}: {
  lock: LockInfo; face: FaceResult; tone: Tone | null;
  onTonePicked: (t: Tone) => void; onNext: () => void;
}) {
  const [depth, setDepth] = useState<string | null>(null);
  const [temp, setTemp] = useState<"warm" | "neutral" | "cool" | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const dist = useMemo(() => colorDistance(lock.productHex, lock.onFaceHex), [lock]);
  const nearIdentical = dist < NEAR_IDENTICAL;
  const facts: string[] = [`skin type: ${face.skinType}`];
  if (tone) facts.push(tone.source === "picker" ? "tone: picked by you" : "tone: read");

  async function saveTone(d: string, t: "warm" | "neutral" | "cool") {
    const sessionId = face.sessionId;
    setSaving(true); setErr(null);
    try {
      const res = await api.postTone(sessionId, d, t);
      onTonePicked({ source: "picker", depth: d, temperature: t });
    } catch {
      setErr("Couldn’t save that. Try once more.");
    } finally { setSaving(false); }
  }

  return (
    <section className="fade-in" aria-label="How it reads on you">
      <p className="eyebrow">Step 3 of 3 · the read</p>
      <h2 className="display" style={{ fontSize: 34, marginBottom: 18 }}>
        {nearIdentical ? "True to the pan on you." : "On you it reads like this."}
      </h2>

      <div className="swatch-pair">
        <Swatch label="The piece" hex={lock.productHex} />
        <Swatch label="On you" hex={lock.onFaceHex} lockMark />
      </div>

      <p className="muted" style={{ fontSize: 14.5, marginTop: 12 }}>
        {nearIdentical
          ? "We’ll build from what’s on your face."
          : "Same product, your light. Everything below starts from the on-you shade."}
      </p>

      <div className="row" style={{ marginTop: 16, flexWrap: "wrap", gap: 8 }}>
        <span className="lock-chip"><span className="dot" />{lock.category} locked</span>
        {lock.unverified && <span className="recipe-chip">unverified sample</span>}
      </div>

      <p className="dim" style={{ fontSize: 13, marginTop: 14 }}>{facts.join("  ·  ")}</p>

      {face.toneFallback && !tone && (
        <div className="card" style={{ marginTop: 18 }}>
          <p style={{ margin: "0 0 10px", fontWeight: 650 }}>Pick your tone — two taps</p>
          <div className="chip-row" role="group" aria-label="Tone depth">
            {["01", "02", "03", "04", "05", "06"].map((d) => (
              <button key={d} className="chip" aria-pressed={depth === d} onClick={() => setDepth(d)}>{d}</button>
            ))}
          </div>
          <div className="chip-row" role="group" aria-label="Tone temperature" style={{ marginTop: 10 }}>
            {(["warm", "neutral", "cool"] as const).map((t) => (
              <button key={t} className="chip" aria-pressed={temp === t} onClick={() => setTemp(t)}>{t}</button>
            ))}
          </div>
          {err && <p className="dim" style={{ fontSize: 13, marginBottom: 0 }}>{err}</p>}
          <button
            className="btn btn-primary btn-wide"
            style={{ marginTop: 14 }}
            disabled={!depth || !temp || saving}
            onClick={() => depth && temp && void saveTone(depth, temp)}
          >
            {saving ? "Saving…" : "Save tone"}
          </button>
        </div>
      )}

      <div style={{ marginTop: 22 }}>
        <button
          className="btn btn-primary btn-wide"
          onClick={onNext}
          disabled={face.toneFallback && !tone}
        >
          Choose the mood
        </button>
      </div>
    </section>
  );
}

function Swatch({ label, hex, lockMark }: { label: string; hex: string; lockMark?: boolean }) {
  return (
    <div className="swatch">
      <div className="fill" style={{ background: hex }} />
      <div className="meta">
        <p style={{ margin: 0, fontWeight: 650, fontSize: 14 }}>{label}{lockMark ? " · locked" : ""}</p>
        <p className="hex" style={{ margin: "1px 0 0" }}>{hex}</p>
      </div>
    </div>
  );
}

/* ================= screen 5: mood + event ================= */

function MoodEventScreen({
  mood, event, onMood, onEvent, onBuild, loading,
}: {
  mood: Mood | null; event: Event | null;
  onMood: (m: Mood) => void; onEvent: (e: Event) => void;
  onBuild: () => void; loading: boolean;
}) {
  return (
    <section className="fade-in" aria-label="Mood and event">
      <p className="eyebrow">Almost there</p>
      <h2 className="display" style={{ fontSize: 34, marginBottom: 6 }}>Dress the moment</h2>
      <p className="muted" style={{ marginTop: 0, marginBottom: 20, fontSize: 14.5 }}>
        They shape the layers around your locked shade — never the shade itself.
      </p>

      <p className="eyebrow" style={{ marginBottom: 8 }}>Mood</p>
      <div className="chip-row" role="group" aria-label="Mood">
        {MOODS.map((m) => (
          <button key={m} className="chip" aria-pressed={mood === m} onClick={() => onMood(m)}>{m}</button>
        ))}
      </div>

      <p className="eyebrow" style={{ margin: "18px 0 8px" }}>Event</p>
      <div className="chip-row" role="group" aria-label="Event">
        {EVENTS.map((e) => (
          <button key={e} className="chip" aria-pressed={event === e} onClick={() => onEvent(e)}>{e}</button>
        ))}
      </div>

      {mood && event && (
        <p className="muted fade-in" style={{ fontSize: 14.5, marginTop: 18 }}>
          Looks built for <strong style={{ color: "var(--ink)" }}>{mood} × {event}</strong>.
        </p>
      )}

      <div style={{ marginTop: 22 }}>
        <button className="btn btn-primary btn-wide" disabled={!mood || !event || loading} onClick={onBuild}>
          {loading ? "Building…" : "Build my three looks"}
        </button>
      </div>
    </section>
  );
}

/* ================= screen 6: the looks ================= */

const ROLE_LABEL: Record<Look["role"], string> = { anchor: "Anchor", lift: "Lift", statement: "Statement" };

function LooksScreen({
  looks, lockHex, category, onShuffle, onChange, onRestart, busy,
}: {
  looks: LooksResult; lockHex: string; category: Category;
  onShuffle: () => void; onChange: () => void; onRestart: () => void; busy: boolean;
}) {
  const out = looks.rendersLeft <= 0;
  return (
    <section aria-label="Your three looks">
      <div className="row" style={{ marginBottom: 14 }}>
        <div className="grow">
          <p className="eyebrow" style={{ margin: 0 }}>Your three looks</p>
          <h2 className="display" style={{ fontSize: 30, margin: 0 }}>Built around your {category}</h2>
        </div>
        <span className="lock-chip"><span className="dot" />{lockHex}</span>
      </div>

      {looks.lockApproximated && (
        <p className="muted" style={{ fontSize: 13.5, marginTop: 0 }}>
          Your shade reads closest to this.
        </p>
      )}

      <div style={{ display: "grid", gap: 16 }}>
        {looks.looks.map((look) => <LookCard key={look.role} look={look} />)}
      </div>

      <div className="row" style={{ marginTop: 20, flexWrap: "wrap", gap: 10 }}>
        <button className="btn btn-primary" onClick={onShuffle} disabled={busy || out}>
          {busy ? "Shuffling…" : out ? "No renders left" : "Shuffle the rest"}
        </button>
        <button className="btn btn-ghost" onClick={onChange} disabled={busy}>Change mood + event</button>
        <button className="btn btn-ghost" onClick={onRestart} disabled={busy}>Start over</button>
      </div>
      <p className="dim" style={{ fontSize: 12.5, marginTop: 10, marginBottom: 0 }}>
        {looks.rendersLeft} render{looks.rendersLeft === 1 ? "" : "s"} left this session.
      </p>
    </section>
  );
}

function LookCard({ look }: { look: Look }) {
  return (
    <article className="look-card fade-in">
      <div className="img-wrap">
        <img src={look.imageUrl} alt={`${ROLE_LABEL[look.role]} look render`} />
      </div>
      <div className="look-head">
        <h3 className="display" style={{ fontSize: 22, margin: 0, flexGrow: 1 }}>{ROLE_LABEL[look.role]}</h3>
        {look.lockApproximated && <span className="recipe-chip">nearest shade</span>}
      </div>
      <div className="look-chips">
        {look.chips.map((c, i) => (
          <span key={`${look.role}-${i}`} className="recipe-chip">
            <span className="dot" style={{ background: c.hex }} />
            {c.label}{c.detail ? ` · ${c.detail}` : ""}
          </span>
        ))}
        {look.shop && (
          <a className="recipe-chip" href={look.shop.url} target="_blank" rel="noreferrer noopener">
            {look.shop.label} ↗
          </a>
        )}
      </div>
    </article>
  );
}
