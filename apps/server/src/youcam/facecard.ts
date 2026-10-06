/**
 * Face compositor for mock mode: renders the actual VTO effect list onto
 * the user's own in-session face photo.
 *
 * The server is the only YouCam caller. In mock mode it has no renderer, so
 * this module composites the same effect list the live engine would receive
 * onto the session's face photo as an SVG: the photo as the base layer plus
 * zone-aligned color patches. When the client sends its detected face
 * landmarks (optional, additive), patches are clipped to the real lip/eye/
 * brow/cheek polygons. Lip, liner, lash, and brow multiply. Blush, shadow,
 * contour, and highlight paint in normal color: soft-light against a close
 * skin hex moves the photo by only a few levels, and phone video then
 * compresses Anchor, Lift, and Statement into the same frame.
 *
 * The deliverable carries no burned-in text: role labels and any mode badges
 * live in UI chrome only (client), never inside the image bytes.
 *
 * Pure function of (photo, effects, landmarks, geometry): deterministic,
 * testable. Output is a data: URL SVG with the JPEG embedded as base layer.
 * Geometry contract: the client normalizes every capture to a 4:5 frame, so
 * photo fractions map 1:1 onto the 1000x1250 canvas (one geometry end to
 * end; the lock ring and the patches share coordinates exactly).
 */

import type { VtoEffect } from "./client.js";

export const CANVAS_W = 1000;
export const CANVAS_H = 1250;

/** A face-zone polygon in photo-fraction coordinates (0..1 pairs, 4:5 frame). */
export type FacePoly = ReadonlyArray<readonly [number, number]>;

/** Face bounding box in photo-fraction coordinates. */
export interface FaceBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

/**
 * Optional client-detected landmarks, sent with POST /face. All fractional.
 * Every field is optional; anything missing falls back to the framing-guide
 * default geometry below.
 */
export interface FaceLandmarks {
  readonly faceBox?: FaceBox | undefined;
  readonly lip?: FacePoly | undefined;
  readonly eyeL?: FacePoly | undefined;
  readonly eyeR?: FacePoly | undefined;
  readonly browL?: FacePoly | undefined;
  readonly browR?: FacePoly | undefined;
  readonly cheekL?: FacePoly | undefined;
  readonly cheekR?: FacePoly | undefined;
}

/**
 * Default face geometry on the 1000x1250 canvas (4:5), mirroring the client's
 * framing-guide proportions. Used when no landmarks arrive.
 */
interface Zone {
  category: string;
  cx: number;
  cy: number;
  rx: number;
  ry: number;
  kind: "patch" | "lash" | "brow";
}

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

function colorIntensityOf(e: VtoEffect): number | undefined {
  const c = firstPalette(e)?.["colorIntensity"];
  return typeof c === "number" ? c : undefined;
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const SUPPORT_BASE: Record<string, number> = {
  blush: 0.7,
  eye_shadow: 0.48,
  eye_liner: 0.78,
  eyebrows: 0.7,
  eyelashes: 0.74,
  contour: 0.58,
  highlighter: 0.46,
};

/**
 * Builder colorIntensity for a supporting layer sits in a narrow band
 * (Soft x Casual statement is about 60, Night out about 66). A linear map
 * of that gap is invisible on camera, so the top of the band is stretched.
 * 0 at the floor, about 1 at a full statement.
 */
function intensityStretch(colorIntensity: number | undefined): number {
  if (colorIntensity === undefined) return 0.6;
  const t = Math.max(0, Math.min(1.25, (colorIntensity - 30) / 40));
  return t < 0.7 ? t : 0.7 + (t - 0.7) * 2.6;
}

/** Statement fullest, Lift mid, Anchor keeps support quiet (lip is separate). */
function roleSupportGain(role: string): number {
  if (role === "statement") return 1.08;
  if (role === "lift") return 0.8;
  return 0.42;
}

/**
 * Lip opacity is the same on every role so the lock hex does not change
 * strength. Support opacity tracks role and the stretched intensity.
 */
function layerOpacity(category: string, colorIntensity: number | undefined, role: string): number {
  if (category === "lip_color") return 0.94;
  const base = SUPPORT_BASE[category] ?? 0.55;
  const s = intensityStretch(colorIntensity);
  const raw = base * roleSupportGain(role) * (0.5 + s * 0.62);
  // Lift's one or two supports have to read on camera even when the builder
  // intensity is the Soft x Casual floor. Liner and lash stay under the cap
  // so they do not paint out the iris.
  const cap = category === "eye_liner" || category === "eyelashes" ? 0.7 : 0.96;
  // Floors keep a single Lift support readable. They stay under the
  // statement paint for the same effect, and under the cap, so a higher
  // colorIntensity (Night out) still has room to get stronger.
  const liftFloor = category === "eyebrows" || category === "eye_liner"
    ? 0.8
    : category === "blush"
      ? 0.5
      : category === "eye_shadow"
        ? 0.58
        : 0.48;
  if (role === "lift") return Math.min(cap, Math.max(liftFloor, raw));
  if (role === "statement") return Math.min(cap, Math.max(raw, liftFloor + 0.08));
  return Math.min(cap, Math.max(0.22, raw));
}

/** How far a support zone grows past the landmark. Lip stays on the mouth. */
function zoneGrow(category: string, colorIntensity: number | undefined, role: string): number {
  if (category === "lip_color") return 1;
  const s = intensityStretch(colorIntensity);
  const roleK = role === "statement" ? 1.2 : role === "lift" ? 1.05 : 0.9;
  if (category === "blush") return roleK * (1.15 + s * 0.5);
  if (category === "contour" || category === "highlighter") return roleK * (1.05 + s * 0.22);
  if (category === "eye_shadow") return roleK * (1.05 + s * 0.2);
  if (category === "eyebrows") return role === "lift" ? 1.65 : 1.15;
  return 1;
}

/* ---------- landmark helpers ---------- */

interface Ellipse {
  cx: number;
  cy: number;
  rx: number;
  ry: number;
}

/** Centroid + extents of a landmark polygon, in canvas pixels. */
function polyEllipse(poly: FacePoly): Ellipse {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, sx = 0, sy = 0;
  for (const [fx, fy] of poly) {
    const x = fx * CANVAS_W;
    const y = fy * CANVAS_H;
    minX = Math.min(minX, x); maxX = Math.max(maxX, x);
    minY = Math.min(minY, y); maxY = Math.max(maxY, y);
    sx += x; sy += y;
  }
  const n = Math.max(1, poly.length);
  return {
    cx: sx / n,
    cy: sy / n,
    rx: Math.max(6, (maxX - minX) / 2),
    ry: Math.max(4, (maxY - minY) / 2),
  };
}

/** Derive a brow ellipse just above an eye when no brow landmark arrived. */
function browFromEye(eye: Ellipse): Ellipse {
  return { cx: eye.cx, cy: eye.cy - eye.ry * 1.9, rx: eye.rx * 0.95, ry: Math.max(5, eye.ry * 0.34) };
}

/** Zone geometry for one effect, landmark-aware with legacy fallback. */
function zonesFor(category: string, lm: FaceLandmarks | undefined): { ellipse: Ellipse; clipPoly: FacePoly | null; kind: Zone["kind"] }[] {
  const scale = (cx: number, cy: number, rx: number, ry: number): Ellipse => ({
    cx: cx * CANVAS_W, cy: cy * CANVAS_H, rx: rx * CANVAS_W, ry: ry * CANVAS_H,
  });
  switch (category) {
    case "lip_color": {
      if (lm?.lip && lm.lip.length >= 3) {
        return [{ ellipse: polyEllipse(lm.lip), clipPoly: lm.lip, kind: "patch" }];
      }
      break;
    }
    case "blush": {
      const out: { ellipse: Ellipse; clipPoly: FacePoly | null; kind: Zone["kind"] }[] = [];
      if (lm?.cheekL && lm.cheekL.length >= 3) out.push({ ellipse: polyEllipse(lm.cheekL), clipPoly: null, kind: "patch" });
      if (lm?.cheekR && lm.cheekR.length >= 3) out.push({ ellipse: polyEllipse(lm.cheekR), clipPoly: null, kind: "patch" });
      if (out.length > 0) return out;
      break;
    }
    case "eye_shadow":
    case "eye_liner":
    case "eyelashes": {
      const out: { ellipse: Ellipse; clipPoly: FacePoly | null; kind: Zone["kind"] }[] = [];
      for (const eye of [lm?.eyeL, lm?.eyeR]) {
        if (eye && eye.length >= 3) {
          const el = polyEllipse(eye);
          if (category === "eye_liner") {
            out.push({ ellipse: { cx: el.cx, cy: el.cy - el.ry * 0.35, rx: el.rx * 0.95, ry: Math.max(4, el.ry * 0.34) }, clipPoly: eye, kind: "lash" });
          } else if (category === "eyelashes") {
            out.push({ ellipse: { cx: el.cx, cy: el.cy + el.ry * 0.45, rx: el.rx * 0.98, ry: Math.max(4, el.ry * 0.4) }, clipPoly: eye, kind: "lash" });
          } else {
            // Lid above the iris, unclipped. Clipping to the eye oval cuts a
            // raised ellipse down to a sliver the camera cannot see.
            out.push({ ellipse: { cx: el.cx, cy: el.cy - el.ry * 0.9, rx: el.rx * 1.35, ry: Math.max(8, el.ry * 0.72) }, clipPoly: null, kind: "patch" });
          }
        }
      }
      if (out.length > 0) return out;
      break;
    }
    case "eyebrows": {
      const out: { ellipse: Ellipse; clipPoly: FacePoly | null; kind: Zone["kind"] }[] = [];
      const brows: (FacePoly | undefined)[] = [lm?.browL, lm?.browR];
      const eyes: (FacePoly | undefined)[] = [lm?.eyeL, lm?.eyeR];
      for (let i = 0; i < 2; i++) {
        const b = brows[i];
        if (b && b.length >= 3) out.push({ ellipse: polyEllipse(b), clipPoly: null, kind: "brow" });
        else if (eyes[i] && eyes[i]!.length >= 3) out.push({ ellipse: browFromEye(polyEllipse(eyes[i]!)), clipPoly: null, kind: "brow" });
      }
      if (out.length > 0) return out;
      break;
    }
    case "contour":
    case "highlighter": {
      if (lm?.faceBox) {
        const f = lm.faceBox;
        if (category === "contour") {
          const cy = (f.y + f.h * 0.62) * CANVAS_H;
          return [
            { ellipse: { cx: (f.x + f.w * 0.1) * CANVAS_W, cy, rx: f.w * CANVAS_W * 0.09, ry: f.h * CANVAS_H * 0.17 }, clipPoly: null, kind: "patch" },
            { ellipse: { cx: (f.x + f.w * 0.9) * CANVAS_W, cy, rx: f.w * CANVAS_W * 0.09, ry: f.h * CANVAS_H * 0.17 }, clipPoly: null, kind: "patch" },
          ];
        }
        return [{
          ellipse: scale(f.x + f.w / 2, f.y + f.h * 0.47, f.w * 0.075, f.h * 0.11),
          clipPoly: null,
          kind: "patch",
        }];
      }
      break;
    }
    default:
      break;
  }
  // Legacy fallback: fixed framing-guide geometry.
  return ZONES
    .filter((z) => z.category === category)
    .map((z) => ({ ellipse: { cx: z.cx, cy: z.cy, rx: z.rx, ry: z.ry }, clipPoly: null, kind: z.kind }));
}

/** Stable jitter per (seed, effect-set): different shuffle -> visible move. */
function categoryJitterSeed(seed: number, effects: VtoEffect[]): number {
  let h = seed | 0;
  for (const e of effects) {
    const c = effectCategory(e);
    for (let i = 0; i < c.length; i++) {
      h ^= c.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
  }
  return ((h >>> 0) % 7) - 3; // -3..3
}

const POLY_CACHE = new WeakMap<FacePoly, string>();
function clipPoints(poly: FacePoly, grow: number): string {
  if (grow === 1) {
    let points = POLY_CACHE.get(poly);
    if (!points) {
      points = poly
        .map(([fx, fy]) => `${(fx * CANVAS_W).toFixed(1)},${(fy * CANVAS_H).toFixed(1)}`)
        .join(" ");
      POLY_CACHE.set(poly, points);
    }
    return points;
  }
  let sx = 0, sy = 0;
  for (const [fx, fy] of poly) { sx += fx; sy += fy; }
  const n = Math.max(1, poly.length);
  const cx = sx / n, cy = sy / n;
  return poly
    .map(([fx, fy]) => {
      const x = cx + (fx - cx) * grow;
      const y = cy + (fy - cy) * grow;
      return `${(x * CANVAS_W).toFixed(1)},${(y * CANVAS_H).toFixed(1)}`;
    })
    .join(" ");
}

/**
 * Compose the mock face render: the user's JPEG as the base image, soft
 * effect patches per zone, blended onto the face. No text is drawn: the
 * saved/shared image contains pixels only. The photo never touches disk; it
 * travels inside the data URL.
 */
export function faceCardSvg(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
  landmarks?: FaceLandmarks | undefined,
): string {
  const softLayers: string[] = [];
  const multLayers: string[] = [];
  const defs: string[] = [
    `<filter id="soft" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="4.5"/></filter>`,
    `<filter id="soft2" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2"/></filter>`,
    `<filter id="soft3" x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="1.4"/></filter>`,
  ];

  // Deterministic micro-jitter so a shuffle render visibly moves soft layers
  // (the anchor look is lock-only by design; a tiny lip-breath keeps the
  // re-apply legible without changing the recipe).
  const jig = categoryJitterSeed(seed, effects);

  let clipN = 0;
  for (const e of effects) {
    const category = effectCategory(e);
    if (category === "skin_smooth") continue;
    const color = effectColor(e);
    if (!color) continue;
    const ci = colorIntensityOf(e);
    const opacity = layerOpacity(category, ci, role);
    const grow = zoneGrow(category, ci, role);
    const multiply = category === "lip_color" || category === "eye_liner" || category === "eyelashes" || category === "eyebrows";
    const bucket = multiply ? multLayers : softLayers;

    for (const z of zonesFor(category, landmarks)) {
      const cx = z.ellipse.cx;
      const cy = z.ellipse.cy;
      // Landmark polys for cheek and brow are a few dozen pixels. Phone video
      // compresses that away, so support ellipses have a minimum size on the
      // 1000px canvas. The lip stays on its polygon.
      const min: Record<string, readonly [number, number]> = {
        blush: [108, 82],
        eyebrows: [92, 30],
        eye_shadow: [96, 38],
        contour: [52, 150],
      };
      const floor = min[category];
      const rx = Math.max(z.ellipse.rx * grow, floor?.[0] ?? 0);
      const ry = Math.max(z.ellipse.ry * grow, floor?.[1] ?? 0);
      const blur = category === "lip_color" || category === "eye_liner" ? "soft3" : multiply ? "soft2" : "soft";
      const jx = jig * (multiply ? 4 : 9);
      let body: string;
      const el = `<ellipse cx="${(cx + jx).toFixed(1)}" cy="${cy.toFixed(1)}" rx="${rx.toFixed(1)}" ry="${ry.toFixed(1)}" fill="${esc(color)}" opacity="${opacity.toFixed(3)}" filter="url(#${blur})"/>`;
      if (z.clipPoly) {
        clipN += 1;
        const id = `clip-${clipN}`;
        const points = clipPoints(z.clipPoly, grow);
        defs.push(`<clipPath id="${id}"><polygon points="${points}"/></clipPath>`);
        body = `<g clip-path="url(#${id})">${el}</g>`;
      } else {
        body = el;
      }
      bucket.push(body);
    }
  }

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${CANVAS_W}" height="${CANVAS_H}" viewBox="0 0 ${CANVAS_W} ${CANVAS_H}">
  <defs>
    ${defs.join("\n    ")}
  </defs>
  <image href="data:image/jpeg;base64,${facePhotoBase64}" x="0" y="0" width="${CANVAS_W}" height="${CANVAS_H}" preserveAspectRatio="xMidYMid slice"/>
  <g>
    ${softLayers.join("\n    ")}
  </g>
  <g style="mix-blend-mode:multiply">
    ${multLayers.join("\n    ")}
  </g>
</svg>`;
}

/** Data-URL form for direct <img src> use by the client. */
export function faceCardDataUrl(
  role: string,
  effects: VtoEffect[],
  seed: number,
  facePhotoBase64: string,
  landmarks?: FaceLandmarks | undefined,
): string {
  const svg = faceCardSvg(role, effects, seed, facePhotoBase64, landmarks);
  return `data:image/svg+xml;base64,${Buffer.from(svg, "utf8").toString("base64")}`;
}
