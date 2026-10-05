/**
 * Mock YouCam pipeline: deterministic, in-process stand-in used when no API
 * key is configured (YOUCAM_MOCK=1 or no YOUCAM_API_KEY). Same interface as
 * the live pipeline so the client contract is identical.
 *
 * IMPORTANT (spec): mock mode renders a placeholder, never a canned "output".
 * It composes a simple SVG face card that visualizes the actual effect list,
 * so the six screens and the demo flow are exercisable offline. Live renders
 * are the only mode shown in the filmed demo.
 */

import type { VtoEffect } from "./client.js";
import type { SkinAnalysisOutcome, SkinToneOutcome } from "./client.js";

export interface MockDeps {
  skinType?: string;
  tZone?: string;
  skinColor?: string;
  /** Inject failures to exercise error paths. */
  failSkin?: boolean;
  failTone?: boolean;
  failVto?: boolean;
}

/** Deterministic pseudo-analysis from the image bytes (so retakes differ). */
function analyzeFaceImage(base64: string): { oil: number; warmth: number; lum: number } {
  let h = 2166136261;
  const step = Math.max(1, Math.floor(base64.length / 2048));
  for (let i = 0; i < base64.length; i += step) {
    h ^= base64.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  const r = (h >>> 0) / 4294967296;
  return { oil: r, warmth: (h >>> 8) % 256 / 256, lum: (h >>> 16) % 256 / 256 };
}

export function mockSkinAnalysis(base64: string, deps: MockDeps): SkinAnalysisOutcome {
  if (deps.failSkin) throw new Error("mock skin failure");
  const a = analyzeFaceImage(base64);
  const type = deps.skinType ?? (a.oil > 0.6 ? "Combination" : a.oil > 0.3 ? "Normal" : "Dry");
  return { whole: type, tZone: deps.tZone ?? (a.oil > 0.55 ? "Oily" : type), uZone: type };
}

export function mockSkinTone(base64: string, deps: MockDeps): SkinToneOutcome {
  if (deps.failTone) throw new Error("mock tone failure");
  const a = analyzeFaceImage(base64);
  const c = deps.skinColor ?? (a.warmth > 0.55 ? "#c28e6b" : a.warmth > 0.3 ? "#d9ab8a" : "#e8c5a8");
  return { skinColor: c };
}

/** Render a schematic face card as a data URL visualizing the effects. */
export function mockRender(role: string, effects: VtoEffect[], seed: number): string {
  const layers = effects.filter((e) => e.category !== "skin_smooth");

  const chips = layers
    .map((e, i) => {
      const p = (e.palettes as { color?: string }[] | undefined)?.[0];
      const color = typeof p?.color === "string" ? p.color : "#888888";
      const name = String(e.category).replace(/_/g, " ");
      return (
        `<g transform="translate(0,${i * 34})">` +
        `<rect x="0" y="0" width="420" height="26" rx="6" fill="${esc(color)}"/>` +
        `<text x="10" y="17" font-size="11" fill="#fff" font-family="monospace">${esc(name)}</text>` +
        `</g>`
      );
    })
    .join("");

  const swatches = layers
    .map((e, i) => {
      const p = (e.palettes as { color?: string }[] | undefined)?.[0];
      const color = typeof p?.color === "string" ? p.color : "#888888";
      return `<rect x="${i * 30}" y="0" width="24" height="24" rx="12" fill="${esc(color)}" stroke="#00000033"/>`;
    })
    .join("");

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="540" height="700" viewBox="0 0 540 700">
  <defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#16141a"/><stop offset="1" stop-color="#241f2b"/>
  </linearGradient></defs>
  <rect width="540" height="700" fill="url(#bg)"/>
  <text x="270" y="60" text-anchor="middle" font-size="28" fill="#f4eee8" font-family="Georgia, serif" font-weight="600">${esc(capitalize(role))}</text>
  <text x="270" y="86" text-anchor="middle" font-size="12" fill="#a89c94" font-family="monospace">MOCK RENDER seed ${seed % 100000}</text>
  <g transform="translate(60,120)">${chips}</g>
  <g transform="translate(60,${150 + layers.length * 34})">${swatches}</g>
  <text x="270" y="660" text-anchor="middle" font-size="11" fill="#6f655f" font-family="monospace">mock mode - no YouCam call</text>
</svg>`;
  return `data:image/svg+xml;base64,${btoa(unescape(encodeURIComponent(svg)))}`;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
