/**
 * Face compositor for mock mode: renders the actual VTO effect list onto
 * the user's own in-session face photo.
 *
 * The server is the only YouCam caller. In mock mode it has no renderer, so
 * this module composites the same effect list the live engine would receive
 * onto the session's face photo as an SVG: the photo as the base layer plus
 * soft color patches in the makeup zones. Same colors, same zones, same
 * recipe - a live visualization of the real input, never a canned output.
 *
 * Pure function of (photo, effects, geometry): deterministic, testable.
 * Output is a data: URL SVG with the JPEG embedded as the base layer.
 */

import type { VtoEffect } from "./client.js";

export const CANVAS_W = 1000;
export const CANVAS_H = 1250;

interface Zone {
  /** VTO category constant that draws in this zone. */
  category: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  kind: "patch" | "lash" | "brow";
}

/**
 * Fixed face geometry on the 1000x1250 canvas (4:5), mirroring the client's
 * framing-guide proportions. Patches are soft and wide: the schematic reads
 * as zones of color on a face, not a photoreal VTO.
 */
const ZONES: readonly Zone[] = [
  { category: "lip_color", cx: 500, cy: 848, rx: 118, ry: 58, kind: "patch" },
  { category: "blush", cx: 316, cy: 668, rx: 112, ry: 84, kind: "patch" },
  { category: "blush", cx: 684, cy: 668, rx: 112, ry: 84, kind: "patch" },
  { category: "eye_shadow", cx: 348, cy: 512, rx: 96, ry: 56, kind: "patch" },
  { category: "eye_shadow", cx: 652, cy: 512, rx: 96, ry: 56, kind: "patch" },
  { category: "eye_liner", cx: 348, cy: 508, rx: 104, ry: 30, kind: "lash" },
  { category: "eye_liner", cx: 652, cy: 508, rx: 104, ry: 30, kind: "lash" },
  { category: "eyebrows", cx: 340, cy: 428, rx: 96, ry: 24, kind: "brow" },
  { category: "eyebrows", cx: 660, cy: 428, rx: 96, ry: 24, kind: "brow" },
  { category: "eyelashes", cx: 348, cy: 536, rx: 100, ry: 34, kind: "lash" },
  { category: "eyelashes", cx: 652, cy: 536, rx: 100, ry: 34, kind: "lash" },
  { category: "contour", cx: 210, cy: 640, rx: 84, ry: 190, kind: "patch" },
  { category: "contour", cx: 790, cy: 640, rx: 84, ry: 190, kind: "patch" },
  { category: "highlighter", cx: 500, cy: 600, rx: 74, ry: 130, kind: "patch" },
];

/** Effect category string, narrowed from the loose VtoEffect record. */
function effectCategory(e: VtoEffect): string {
  return typeof e.category === "string" ? e.category : "";
}

/** First palette entry of an effect (effects always carry palettes). */
function firstPalette(e: VtoEffect): Record<string, unknown> | null {
  if (!Array.isArray(e.palettes)) return null;
  const p = (e.palettes as unknown[])[0];
  return p && typeof p === "object" ? (p as Record<string, unknown>) : null;
}

/** First palette color of an effect. */
function effectColor(e: VtoEffect): string | null {
  const c = firstPalette(e)?.["color"];
  return typeof c === "string" ? c : null;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/** Opacity for a category so layered effects stay soft and photo-backed. */
function catOpacity(c: string, colorIntensity: number | undefined): number {
  const base: Record<string, number> = {
    lip_color: 0.5,
    blush: 0.3,
    eye_shadow: 0.34,
    eye_liner: 0.6,
    eyebrows: 0.5,
    eyelashes: 0.55,
    contour: 0.18,
    highlighter: 0.16,
  };
  const b = base[c] ?? 0.3;
  if (colorIntensity === undefined) return b;
  return Math.max(0.08, Math.min(0.72, b * (0.6 + (colorIntensity / 100) * 0.6)));
}

function colorIntensityOf(e: VtoEffect): number | undefined {
  const c = firstPalette(e)?.["colorIntensity"];
  return typeof c === "number" ? c : undefined;
}

/**
 * Compose the mock face render: the user's JPEG as the base image, soft
 * effect patches per zone, and a small role/mock badge. The photo never
 * touches disk; it travels inside the data URL.
 */
export function faceCardSvg(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
): string {
  const layers: string[] = [];
  for (const e of effects) {
    const category = effectCategory(e);
    if (category === "skin_smooth") continue;
    const color = effectColor(e);
    if (!color) continue;
    const opacity = catOpacity(category, colorIntensityOf(e));
    for (const z of ZONES) {
      if (z.category !== category) continue;
      if (z.kind === "lash" || z.kind === "brow") {
        layers.push(
          `<ellipse cx="${z.cx}" cy="${z.cy}" rx="${z.rx}" ry="${z.ry}" fill="${esc(color)}" opacity="${opacity.toFixed(3)}"/>`,
        );
      } else {
        layers.push(
          `<ellipse cx="${z.cx}" cy="${z.cy}" rx="${z.rx}" ry="${z.ry}" fill="${esc(color)}" opacity="${opacity.toFixed(3)}" filter="url(#soft)"/>`,
        );
      }
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    <filter id="soft" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="26"/>
    </filter>
    <filter id="soft2" x="-30%" y="-30%" width="160%" height="160%">
      <feGaussianBlur stdDeviation="10"/>
    </filter>
  </defs>
  <image href="data:image/jpeg;base64,${facePhotoBase64}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="xMidYMid slice"/>
  ${layers.join("\n  ")}
  <g font-family="ui-monospace, monospace">
    <rect x="24" y="24" rx="999" width="${Math.min(460, 30 + String(role).length * 22 + 90)}" height="40" fill="rgba(10,10,14,0.66)"/>
    <text x="44" y="50" font-size="20" font-weight="700" letter-spacing="2" fill="#f4eee8">${esc(capitalize(role))}</text>
    <text x="${44 + String(role).length * 14 + 26}" y="50" font-size="15" fill="#a89c94">MOCK seed ${seed % 100000}</text>
  </g>
</svg>`;
}

/** Data-URL form for direct <img src> use by the client. */
export function faceCardDataUrl(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
): string {
  const svg = faceCardSvg(role, effects, seed, facePhotoBase64);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
