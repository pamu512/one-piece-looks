import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, type Category, sampleDisk } from "../lib/types";

/* ---------- capture guidance per category ---------- */

export const PRODUCT_GUIDE: Record<Category, { shape: "oval" | "circle" | "slim"; lines: string[] }> = {
  lip: { shape: "oval", lines: ["Rest the bullet in view", "Plain background, even light", "Let it fill the frame — no glare"] },
  cheek: { shape: "circle", lines: ["Open the pan flat to the camera", "Plain background, even light", "One shade filling the frame"] },
  eye: { shape: "circle", lines: ["Hold the pan or pressed shade steady", "Plain background, even light", "One shade filling the frame"] },
  brow: { shape: "slim", lines: ["Show the pencil tip or pomade pot", "Plain background, even light", "Close enough to read the color"] },
  liner: { shape: "slim", lines: ["Show the tip or applicator", "Plain background, even light", "Close enough to read the color"] },
};

export const FACE_GUIDE: Record<Category, { lines: string[]; zone: string }> = {
  lip: { lines: ["Wear it, then shoot", "Mouth closed, straight-on", "Same spot, same light as before"], zone: "Tap the center of your lips" },
  cheek: { lines: ["Wear it, then shoot", "A slight smile helps", "Same spot, same light as before"], zone: "Tap the apple of your cheek" },
  eye: { lines: ["Wear it, then shoot", "Eyes open, looking straight", "Same spot, same light as before"], zone: "Tap the center of your lid" },
  brow: { lines: ["Wear it, then shoot", "Neutral face, brows relaxed", "Same spot, same light as before"], zone: "Tap the middle of your brow" },
  liner: { lines: ["Wear it, then shoot", "Eyes open, looking straight", "Same spot, same light as before"], zone: "Tap along your upper lash line" },
};

/** Per-category gate: returns the single most relevant retake reason, or null. */
export function faceGate(
  category: Category,
  onFaceHex: string,
  skinRefHex: string | null,
): { reason: string; fix: string } | null {
  if (!skinRefHex) return null; // no reference sample yet: nothing to compare
  const { contrastRatio } = require0();
  const cr = contrastRatio(onFaceHex, skinRefHex);
  const cd = colorDistance0(onFaceHex, skinRefHex);
  const tooClose =
    category === "lip" ? cd < 60 :
    category === "cheek" ? cd < 45 :
    category === "eye" ? cd < 45 :
    category === "brow" ? cd < 40 :
    cd < 40;
  if (tooClose || cr < 1.18) {
    const fix: Record<Category, string> = {
      lip: "apply a touch more",
      cheek: "a little more on the apple",
      eye: "a touch more than usual",
      brow: "fill a shade heavier",
      liner: "slightly thicker reads better",
    };
    return { reason: "Hard to read the color on your skin", fix: fix[category] };
  }
  return null;
}
// tiny local aliases to avoid circular import cost at module init
function require0() {
  return { contrastRatio: (a: string, b: string) => {
    const lum = (h: string) => {
      const s = h.replace("#", "");
      const c: [number, number, number] = [0, 2, 4].map((i) => parseInt(s.slice(i, i + 2), 16) || 0) as [number, number, number];
      const f = (v: number) => (v / 255 <= 0.04045 ? v / 255 / 12.92 : Math.pow((v / 255 + 0.055) / 1.055, 2.4));
      return 0.2126 * f(c[0]) + 0.7152 * f(c[1]) + 0.0722 * f(c[2]);
    };
    const l1 = lum(a), l2 = lum(b);
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  } };
}
function colorDistance0(a: string, b: string) {
  const p = (h: string): [number, number, number] =>
    [0, 2, 4].map((i) => parseInt(h.replace("#", "").slice(i, i + 2), 16) || 0) as [number, number, number];
  const [r1, g1, b1] = p(a), [r2, g2, b2] = p(b);
  const rm = (r1 + r2) / 2;
  return Math.sqrt((2 + rm / 256) * (r1 - r2) ** 2 + 4 * (g1 - g2) ** 2 + (2 + (255 - rm) / 256) * (b1 - b2) ** 2);
}

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

/* ---------- tap-to-sample over a still photo ---------- */

export function TapSampleStage({
  photoDataUrl,
  zoneHint,
  onSample,
  sampleMark,
}: {
  photoDataUrl: string;
  zoneHint: string;
  onSample: (hex: string, ctx: CanvasRenderingContext2D, pt: { x: number; y: number }) => void;
  sampleMark: { x: number; y: number } | null;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [dims, setDims] = useState<{ w: number; h: number } | null>(null);

  const handle = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const c = canvasRef.current;
    if (!c) return;
    const rect = c.getBoundingClientRect();
    const x = Math.round(((e.clientX - rect.left) / rect.width) * c.width);
    const y = Math.round(((e.clientY - rect.top) / rect.height) * c.height);
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    const hex = sampleDisk(ctx, x, y, Math.max(6, Math.round(c.width * 0.012)));
    onSample(hex, ctx, { x: e.clientX - rect.left, y: e.clientY - rect.top });
  };

  return (
    <div className="camera-stage">
      <canvas
        ref={(c) => {
          if (!c) return;
          canvasRef.current = c;
          const img = new Image();
          img.onload = () => {
            c.width = img.naturalWidth;
            c.height = img.naturalHeight;
            c.getContext("2d", { willReadFrequently: true })!.drawImage(img, 0, 0);
            setDims({ w: c.width, h: c.height });
          };
          img.src = photoDataUrl;
        }}
        onClick={handle}
        role="button"
        tabIndex={0}
        aria-label={`Sample point — ${zoneHint}`}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            // keyboard: sample center of image as accessible default
            const c = canvasRef.current;
            if (!c) return;
            const ctx = c.getContext("2d", { willReadFrequently: true })!;
            const hex = sampleDisk(ctx, Math.round(c.width / 2), Math.round(c.height / 2), Math.max(6, Math.round(c.width * 0.012)));
            const rect = c.getBoundingClientRect();
            onSample(hex, ctx, { x: rect.width / 2, y: rect.height / 2 });
          }
        }}
      />
      {sampleMark && (
        <span
          aria-hidden
          style={{
            position: "absolute",
            left: `calc(${(sampleMark.x)}px)`,
            top: `calc(${(sampleMark.y)}px)`,
            transform: "translate(-50%, -50%)",
            width: 26, height: 26, borderRadius: "50%",
            border: "2.5px solid #fff",
            boxShadow: "0 0 0 2px rgba(0,0,0,.55)",
            pointerEvents: "none",
          }}
        />
      )}
      <div
        aria-hidden
        style={{
          position: "absolute", left: 12, right: 12, bottom: 12,
          textAlign: "center", fontSize: 13, color: "#fff",
          textShadow: "0 1px 8px rgba(0,0,0,.8)", pointerEvents: "none",
        }}
      >
        {zoneHint}
      </div>
      {dims ? null : <div className="skel" style={{ position: "absolute", inset: 0 }} />}
    </div>
  );
}

/* ---------- framing guide overlay ---------- */

export function GuideOverlay({ kind }: { kind: "oval" | "circle" | "slim" | "face" }) {
  const stroke = "rgba(255,255,255,.75)";
  const dash = "rgba(255,255,255,.35)";
  return (
    <svg className="guide-overlay" viewBox="0 0 300 400" aria-hidden>
      {kind === "oval" && <ellipse cx="150" cy="200" rx="72" ry="92" fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="10 8" />}
      {kind === "circle" && <circle cx="150" cy="200" r="95" fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="10 8" />}
      {kind === "slim" && <rect x="112" y="130" width="76" height="140" rx="34" fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="10 8" />}
      {kind === "face" && (
        <>
          <ellipse cx="150" cy="196" rx="88" ry="116" fill="none" stroke={stroke} strokeWidth="2" strokeDasharray="12 9" />
          <line x1="66" y1="150" x2="234" y2="150" stroke={dash} strokeWidth="1.5" />
          <line x1="66" y1="196" x2="234" y2="196" stroke={dash} strokeWidth="1.5" />
          <line x1="66" y1="242" x2="234" y2="242" stroke={dash} strokeWidth="1.5" />
        </>
      )}
    </svg>
  );
}

/* ---------- loading phases ---------- */

export const PHASE_COPY = {
  sampling: "Sampling your color",
  skin: "Reading your skin type",
  building: "Building your three looks",
} as const;
export type Phase = keyof typeof PHASE_COPY;

export function PhaseLine({ phase }: { phase: Phase | null }) {
  if (!phase) return null;
  return (
    <p className="muted" role="status" aria-live="polite" style={{ textAlign: "center", fontSize: 14.5 }}>
      {PHASE_COPY[phase]}…
    </p>
  );
}

/* ---------- calm error card ---------- */

export function CalmError({ msg, onRetry, onBack }: { msg: string; onRetry?: (() => void) | undefined; onBack?: (() => void) | undefined }) {
  return (
    <div className="calm-card fade-in" role="alert">
      <p style={{ margin: "0 0 4px", fontWeight: 600 }}>That didn’t go through</p>
      <p className="muted" style={{ margin: "0 0 14px", fontSize: 14 }}>{msg}</p>
      <p className="dim" style={{ margin: "0 0 14px", fontSize: 13 }}>Your photos and locked color are still here.</p>
      <div className="row">
        {onRetry && <button className="btn btn-primary" onClick={onRetry}>Try again</button>}
        {onBack && <button className="btn btn-ghost" onClick={onBack}>Back</button>}
        <span className="grow" />
      </div>
    </div>
  );
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}
