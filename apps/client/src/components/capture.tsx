import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { hexToRgb, sampleDisk, type Category } from "../lib/types";

/* ---------- camera hook with file-pick fallback ---------- */

export function useCamera() {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const [state, setState] = useState<"idle" | "starting" | "live" | "denied">("idle");

  const stop = useCallback(() => {
    streamRef.current?.getTracks().forEach((t) => t.stop());
    streamRef.current = null;
    setState("idle");
  }, []);

  const start = useCallback(async () => {
    setState("starting");
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 1706 } },
        audio: false,
      });
      streamRef.current = stream;
      const v = videoRef.current;
      if (v) {
        v.srcObject = stream;
        await v.play().catch(() => undefined);
      }
      setState("live");
    } catch {
      setState("denied");
    }
  }, []);

  useEffect(() => () => stop(), [stop]);

  const grab = useCallback((): string | null => {
    const v = videoRef.current;
    if (!v || !v.videoWidth) return null;
    const c = document.createElement("canvas");
    c.width = v.videoWidth;
    c.height = v.videoHeight;
    c.getContext("2d")!.drawImage(v, 0, 0);
    return c.toDataURL("image/jpeg", 0.92);
  }, []);

  return { videoRef, state, start, stop, grab };
}

/* ---------- face framing guide: soft glowing oval ---------- */

export function FaceGuideOverlay() {
  return (
    <svg className="guide-overlay" viewBox="0 0 300 400" aria-hidden>
      <defs>
        <radialGradient id="guideGlow" cx="50%" cy="50%" r="50%">
          <stop offset="72%" stopColor="rgba(255,255,255,0)" />
          <stop offset="88%" stopColor="rgba(255,255,255,0.30)" />
          <stop offset="100%" stopColor="rgba(255,255,255,0)" />
        </radialGradient>
      </defs>
      <ellipse cx="150" cy="196" rx="92" ry="120" fill="url(#guideGlow)" />
      <ellipse cx="150" cy="196" rx="86" ry="113" fill="none" stroke="rgba(255,255,255,0.22)" strokeWidth="1.5" />
    </svg>
  );
}

/* ---------- tap-to-sample canvas over the normalized 4:5 frame ---------- */

export interface SamplePoint { xPct: number; yPct: number }

export interface SampleCanvasHandle {
  /** Sample at fractional coordinates (0..1) of the 4:5 frame. */
  sampleAt: (fx: number, fy: number) => void;
}

/**
 * Full-bleed still + tap sampling. The photo never leaves this stage;
 * overlays (scan line, lock ring, hints) render on top of it.
 */
export const SampleCanvas = forwardRef<SampleCanvasHandle, {
  src: string;
  ariaLabel: string;
  onSample: (hex: string, pt: SamplePoint) => void;
  children?: React.ReactNode;
  disabled?: boolean;
}>(function SampleCanvas({ src, ariaLabel, onSample, children, disabled = false }, ref) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const c = canvasRef.current;
    if (!c) return;
    setReady(false);
    const img = new Image();
    img.onload = () => {
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0);
      setReady(true);
    };
    img.src = src;
  }, [src]);

  const sampleAt = useCallback((fx: number, fy: number) => {
    const c = canvasRef.current;
    if (!c || !c.width) return;
    const x = Math.round(fx * c.width);
    const y = Math.round(fy * c.height);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const hex = sampleDisk(ctx, x, y, Math.max(6, Math.round(c.width * 0.012)));
    onSample(hex, { xPct: fx * 100, yPct: fy * 100 });
  }, [onSample]);

  useImperativeHandle(ref, () => ({ sampleAt }), [sampleAt]);

  return (
    <div className="face-fill">
      <canvas
        ref={canvasRef}
        onClick={(e) => {
          if (disabled) return;
          const rect = e.currentTarget.getBoundingClientRect();
          sampleAt((e.clientX - rect.left) / rect.width, (e.clientY - rect.top) / rect.height);
        }}
        role="button"
        tabIndex={0}
        aria-label={ariaLabel}
        onKeyDown={(e) => {
          if (disabled) return;
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            sampleAt(0.5, 0.7); // keyboard: sample the lip band as default
          }
        }}
      />
      {children}
      {ready ? null : <div className="skel" style={{ position: "absolute", inset: 0 }} />}
    </div>
  );
});

/* ---------- the lock ring: stamp on the sampled point ---------- */

export function LockRing({
  point, hex, category, reveal, onToggle, compact = false,
}: {
  point: SamplePoint; hex: string; category: Category; reveal: boolean; onToggle: () => void; compact?: boolean;
}) {
  return (
    <button
      type="button"
      className={`lock-ring${compact ? " compact" : ""}`}
      style={{ left: `${point.xPct}%`, top: `${point.yPct}%` }}
      onClick={(e) => { e.stopPropagation(); onToggle(); }}
      aria-pressed={reveal}
      aria-label={`Locked ${category}${reveal ? ` color ${hex}` : " color"}. Tap to ${reveal ? "hide" : "show"} the hex.`}
    >
      <span className="lock-ring-dot" style={{ borderColor: hex }} />
      <span className="lock-ring-label">{reveal ? hex : "Locked"}</span>
    </button>
  );
}

/* ---------- "reading your color" scan animation ---------- */

export function ScanLine({ active }: { active: boolean }) {
  if (!active) return null;
  return (
    <div className="scan" aria-hidden>
      <div className="scan-beam" />
      <span className="scan-note" role="status" aria-live="polite">Reading your color…</span>
    </div>
  );
}

/* ---------- soft skin gate ---------- */

/**
 * Heuristic: does this sample read as bare skin rather than makeup?
 * Low chroma, red dominant, mid luma. Soft signal only - it drives a nudge
 * line on the photo; continuing anyway marks the sample unverified.
 */
export function looksLikeSkin(hex: string): boolean {
  const { r, g, b } = hexToRgb(hex);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const chroma = (max - min) / 255;
  const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  const redDominant = r >= g && r >= b && r - b > 8;
  return chroma < 0.24 && redDominant && luma > 0.3 && luma < 0.92;
}

/* ---------- loading phases ---------- */

export const PHASE_COPY = {
  skin: "Reading your skin",
  building: "Building your three looks",
} as const;
export type Phase = keyof typeof PHASE_COPY;

export function PhaseLine({ phase }: { phase: Phase | null }) {
  if (!phase) return null;
  return (
    <p className="phase-line" role="status" aria-live="polite">{PHASE_COPY[phase]}…</p>
  );
}

/* ---------- calm error card ---------- */

export function CalmError({ msg, onRetry, onBack }: { msg: string; onRetry?: (() => void) | undefined; onBack?: (() => void) | undefined }) {
  return (
    <div className="calm-card fade-in" role="alert">
      <p style={{ margin: "0 0 4px", fontWeight: 600 }}>That didn't go through</p>
      <p className="muted" style={{ margin: "0 0 14px", fontSize: 14 }}>{msg}</p>
      <p className="dim" style={{ margin: "0 0 14px", fontSize: 13 }}>Your photo and locked color are still here.</p>
      <div className="row">
        {onRetry && <button className="btn btn-primary" onClick={onRetry}>Try again</button>}
        {onBack && <button className="btn btn-ghost" onClick={onBack}>Back</button>}
        <span className="grow" />
      </div>
    </div>
  );
}
