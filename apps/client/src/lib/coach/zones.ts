/**
 * Coach zones and ribbons: the per-face contour map geometry.
 *
 * Spec: docs/FACE-GEOMETRY.md section 5. Two primitives:
 *   - zones: soft radial fills anchored at mesh points (blush, highlight)
 *   - ribbons: tapered strokes along mesh arcs with a sin^k width profile,
 *     sampled N times and offset along the 2D normal into a closed polygon
 *
 * All construction happens on the NORMALIZED points from measure.ts
 * (roll-fixed, IOD-scaled), so widths are in IOD units and coordinates are
 * frame fractions after the inverse transform. The skin hull is the
 * face-oval loop; every emitted polygon must stay inside it.
 *
 * Descriptive stance: this is geometry only - nothing here warps the face.
 */

import type { NormalizedFace } from "./measure.ts";

/** The canonical face-oval loop (spec section 3; same tuple as faceMesh.ts). */
export const FACE_OVAL_INDICES = [
  10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379,
  378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127,
  162, 21, 54, 103, 67, 109,
] as const;

export interface Pt {
  x: number;
  y: number;
}

/** A soft-fill zone: polygon plus its Gaussian falloff radius. */
export interface Zone {
  id: string;
  /** Polygon in normalized frame fractions. */
  poly: Pt[];
  /** Gaussian radius in IOD units (rendering hint). */
  radiusIod: number;
  kind: "zone";
}

/** A tapered stroke: closed polygon built from a centerline + width profile. */
export interface Ribbon {
  id: string;
  poly: Pt[];
  /** Max half-width at the center of the stroke, IOD units. */
  widthMaxIod: number;
  kind: "ribbon";
  /**
   * The ordered brush path (start -> end), resampled to RIBBON_SAMPLES.
   * The live coach animates along this; brush direction is craft, not
   * decoration.
   */
  centerline?: Pt[];
}

export type ZoneOrRibbon = Zone | Ribbon;

/** Samples per ribbon centerline (spec: N ~ 24). */
export const RIBBON_SAMPLES = 24;
/** Width profile exponent (spec: k ~ 0.7, both ends taper to zero). */
const WIDTH_K = 0.7;

/** Zone catalog ids (section 5.1). */
export type ZoneId =
  | "cheek_apple_L" | "cheek_apple_R"
  | "under_eye_L" | "under_eye_R"
  | "chin_ball"
  | "forehead_center"
  | "cupid_bow"
  | "nose_bridge";

/** Ribbon catalog ids (section 5.2). */
export type RibbonId =
  | "temple_L" | "temple_R"
  | "jaw_L" | "jaw_R"
  | "cheek_shelf_L" | "cheek_shelf_R"
  | "cheek_tip_L" | "cheek_tip_R"
  | "under_chin"
  | "hairline_top";

/** |yaw| where the ear→hollow blend is 1. f(0) = 0 on the faceYawDeg scale. */
export const YAW_MEDIAL_FULL_DEG = 25;

/** 0 at yaw 0, 1 once |yaw| reaches YAW_MEDIAL_FULL_DEG. Non-finite yaw stays 0. */
export function yawMedialT(yawDeg: number): number {
  if (!Number.isFinite(yawDeg)) return 0;
  const a = Math.abs(yawDeg);
  if (!(a > 0)) return 0;
  const u = Math.min(1, a / YAW_MEDIAL_FULL_DEG);
  return u * u * (3 - 2 * u);
}

/** Ear→hollow. f(0) keeps the ear index. Shelf 234→123, 116→147; 454→352, 345→376. Tip 227→117; 447→346. */
export const CHEEK_YAW_ANCHOR: Record<"cheek_shelf_L" | "cheek_shelf_R" | "cheek_tip_L" | "cheek_tip_R", readonly (readonly [number, number])[]> = {
  cheek_shelf_L: [[234, 123], [116, 147]],
  cheek_shelf_R: [[454, 352], [345, 376]],
  cheek_tip_L: [[227, 117]],
  cheek_tip_R: [[447, 346]],
};

/** Hollow midpoint for placement checks: the two medial shelf landmarks. */
export const CHEEK_HOLLOW_INDEX = {
  cheek_shelf_L: [123, 147] as const,
  cheek_shelf_R: [352, 376] as const,
} as const;

export const CHEEK_EAR_INDEX = { cheek_shelf_L: 234, cheek_shelf_R: 454 } as const;

/** mirrorable catalogs: zones/ribbons emitted as L/R pairs where sensible. */
export interface ContourMap {
  zones: Zone[];
  ribbons: Ribbon[];
  /** The skin hull polygon the invariants are checked against. */
  skinHull: Pt[];
}

function at(face: NormalizedFace, i: number): Pt {
  const p = face.points.get(i);
  if (!p) throw new Error(`landmark ${i} missing`);
  return p;
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Ear point at t=0. Missing or non-finite medial point stays on the ear point. */
function yawAnchor(face: NormalizedFace, earIdx: number, medialIdx: number, t: number): Pt {
  const ear = at(face, earIdx);
  if (!(t > 0)) return ear;
  const med = face.points.get(medialIdx);
  if (!med || !Number.isFinite(med.x) || !Number.isFinite(med.y)) return ear;
  return lerp(ear, med, t);
}

/** Catmull-Rom sample of an open polyline (densifies sparse mesh arcs). */
function smoothArc(arc: Pt[], samples: number): Pt[] {
  if (arc.length < 2) return arc.slice();
  const pts = [arc[0], ...arc, arc[arc.length - 1]];
  const out: Pt[] = [];
  const segs = arc.length - 1;
  for (let s = 0; s < samples; s++) {
    const t = (s / (samples - 1)) * segs;
    const i = Math.min(Math.floor(t), segs - 1);
    const u = t - i;
    const p0 = pts[i] as Pt, p1 = pts[i + 1] as Pt, p2 = pts[i + 2] as Pt, p3 = pts[i + 3] as Pt;
    const u2 = u * u, u3 = u2 * u;
    out.push({
      x: 0.5 * (2 * p1.x + (-p0.x + p2.x) * u + (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * u2 + (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * u3),
      y: 0.5 * (2 * p1.y + (-p0.y + p2.y) * u + (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * u2 + (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * u3),
    });
  }
  return out;
}

/**
 * Ribbon polygon: centerline sampled N times, half-width w(t) =
 * wMax * sin(pi t)^k, offset along the local normal on both sides.
 */
export function ribbonPolygon(centerline: Pt[], widthMaxIod: number, _iod = 1): Pt[] {
  const N = RIBBON_SAMPLES;
  const line = centerline.length >= 3 ? smoothArc(centerline, N) : centerline.slice(0, N);
  const left: Pt[] = [];
  const right: Pt[] = [];
  for (let i = 0; i < line.length; i++) {
    const prev = line[Math.max(0, i - 1)] as Pt;
    const next = line[Math.min(line.length - 1, i + 1)] as Pt;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    // normal in frame fractions: the frame is 4:5, but in the normalized
    // IOD space both axes share the unit, so the geometric normal is exact.
    const nx = -dy / len;
    const ny = dx / len;
    const t = line.length === 1 ? 0.5 : i / (line.length - 1);
    const w = widthMaxIod * Math.pow(Math.sin(Math.PI * t), WIDTH_K) * 0.5;
    left.push({ x: line[i]!.x + nx * w, y: line[i]!.y + ny * w });
    right.push({ x: line[i]!.x - nx * w, y: line[i]!.y - ny * w });
  }
  return [...left, ...right.reverse()];
}

/** Radial disc approximating the soft Gaussian zone footprint. */
function discPoly(center: Pt, radiusIod: number, _iod = 1, n = 16): Pt[] {
  const r = radiusIod;
  const out: Pt[] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    out.push({ x: center.x + Math.cos(a) * r, y: center.y + Math.sin(a) * r });
  }
  return out;
}

/** Triangle zone from three anchors, inset toward the face midline (mirror-symmetric). */
function triPoly(a: Pt, b: Pt, c: Pt, inset: number, midX: number): Pt[] {
  const pull = (p: Pt): Pt => ({ x: p.x + (midX - p.x) * inset, y: p.y + inset * 0.004 });
  return [pull(a), pull(b), pull(c)];
}

/** Intersect a ray from `center` through `q` with the hull boundary. */
function rayExit(center: Pt, q: Pt, hull: readonly Pt[]): Pt {
  const dx = q.x - center.x;
  const dy = q.y - center.y;
  let lo = 0, hi = 4; // beyond frame diagonal; shrinks to the crossing
  for (let iter = 0; iter < 40; iter++) {
    const mid = (lo + hi) / 2;
    const probe = { x: center.x + dx * mid, y: center.y + dy * mid };
    if (pointInPoly(probe.x, probe.y, hull)) lo = mid;
    else hi = mid;
  }
  // settle a hair inside the boundary so vertex-inside checks hold
  const t = lo * 0.995;
  return { x: center.x + dx * t, y: center.y + dy * t };
}

/** Zone polygon clipped to the skin hull: outside vertices slide onto the boundary. */
function clipToHull(poly: Pt[], center: Pt, hull: readonly Pt[]): Pt[] {
  return poly.map((q) => (pointInPoly(q.x, q.y, hull) ? q : rayExit(center, q, hull)));
}

/**
 * Build the full catalog for one normalized face. Deterministic: the same
 * face in, the same polygons out (no RNG anywhere). Every polygon is
 * clipped to the skin hull (spec 5.1: "clipped to skin hull").
 */
export function buildContourMap(face: NormalizedFace, yawDeg = 0): ContourMap {
  const iod = face.iod;
  const p = (i: number) => at(face, i);
  const t = yawMedialT(yawDeg);
  const pair = (id: keyof typeof CHEEK_YAW_ANCHOR, i: number): Pt => {
    const row = CHEEK_YAW_ANCHOR[id][i];
    if (!row) throw new Error(`missing yaw anchor ${id} ${i}`);
    return yawAnchor(face, row[0], row[1], t);
  };
  const zones: Zone[] = [];
  const ribbons: Ribbon[] = [];

  const pushZone = (id: ZoneId, poly: Pt[], radiusIod: number) => zones.push({ id, poly, radiusIod, kind: "zone" });
  const pushRibbon = (id: RibbonId, centerline: Pt[], widthMaxIod: number) => {
    const line = centerline.length >= 3 ? smoothArc(centerline, RIBBON_SAMPLES) : centerline.slice(0, RIBBON_SAMPLES);
    ribbons.push({ id, poly: ribbonPolygon(centerline, widthMaxIod, iod), widthMaxIod, kind: "ribbon", centerline: line });
  };

  // ---- zones (5.1) ----
  // cheek_apple: radial gaussian at 205/425, radius ~0.18 CW. CW is read
  // off the normalized points (IOD units), so the radius is CW_IOD * 0.18.
  const cw = Math.hypot(p(127).x - p(356).x, p(127).y - p(356).y);
  const appleR = cw * 0.18;
  pushZone("cheek_apple_L", discPoly(p(205), appleR, iod), appleR);
  pushZone("cheek_apple_R", discPoly(p(425), appleR, iod), appleR);

  // under_eye: small triangle 133-145-230 / 362-374-450, inset 10% toward the
  // face midline (mirror-symmetric by construction: each side pulls to ITS
  // own midline distance, so the pair mirrors about the nose axis).
  const midX = p(4).x;
  pushZone("under_eye_L", triPoly(p(133), p(145), p(230), 0.1, midX), 0.06);
  pushZone("under_eye_R", triPoly(p(362), p(374), p(450), 0.1, midX), 0.06);

  // chin_ball: rounded patch on 175-152-199
  pushZone("chin_ball", discPoly({ x: (p(175).x + p(152).x + p(199).x) / 3, y: (p(175).y + p(152).y + p(199).y) / 3 }, 0.07, iod), 0.07);

  // forehead_center: thin arc 109-10-338 under the hairline
  pushRibbon("hairline_top", [p(109), p(10), p(338)], 0.09);
  pushZone("forehead_center", smoothArc([p(109), p(10), p(338)], 10).map((q) => ({ x: q.x, y: q.y + 0.02 * iod })), 0.05);

  // cupid_bow: tiny arc above the upper-lip top center (0)
  pushZone("cupid_bow", discPoly({ x: p(0).x, y: p(0).y - 0.015 * iod }, 0.03, iod), 0.03);

  // nose_bridge: thin line 168-6-4, width 0.03 IOD (zone catalog per spec,
  // constructed with the ribbon stroke primitive)
  pushZone("nose_bridge", ribbonPolygon([p(168), p(6), p(4)], 0.03), 0.03);

  // ---- ribbons (5.2) ----
  pushRibbon("temple_L", [p(103), p(54), p(21), p(162)], 0.1);
  pushRibbon("temple_R", [p(332), p(284), p(251), p(389)], 0.1);
  pushRibbon("jaw_L", [p(172), p(136), p(150), p(149), p(176)], 0.12);
  pushRibbon("jaw_R", [p(397), p(365), p(379), p(378), p(400)], 0.12);
  // cheek_shelf: ear top toward the mouth corner, stopping ~60% of the way
  pushRibbon("cheek_shelf_L", [pair("cheek_shelf_L", 0), pair("cheek_shelf_L", 1), lerp(p(50), p(61), 0.6)], 0.08);
  pushRibbon("cheek_shelf_R", [pair("cheek_shelf_R", 0), pair("cheek_shelf_R", 1), lerp(p(280), p(291), 0.6)], 0.08);
  // cheek_tip: rides ON the cheekbone widest point (116/345) angled down the
  // face side — the diamond placement ("tips of the cheekbones, not
  // underneath"). cheek_shelf shades the hollow BELOW the bone (round/square
  // placement); cheek_tip shades the width AT the bone.
  pushRibbon("cheek_tip_L", [pair("cheek_tip_L", 0), p(116), p(205), p(50)], 0.07);
  pushRibbon("cheek_tip_R", [pair("cheek_tip_R", 0), p(345), p(425), p(280)], 0.07);
  // under_chin: 148-152-377 arc, inset down (toward the neck)
  pushRibbon("under_chin", [p(148), { x: p(152).x, y: p(152).y + 0.015 * iod }, p(377)], 0.1);

  const skinHull = FACE_OVAL_INDICES.map((i) => p(i));
  for (const z of zones) z.poly = clipToHull(z.poly, { x: p(4).x, y: p(4).y }, skinHull);
  for (const r of ribbons) r.poly = clipToHull(r.poly, { x: p(4).x, y: p(4).y }, skinHull);
  return { zones, ribbons, skinHull };
}

/* ---------- invariant helpers (used by zones.test.ts and probes) ---------- */

/** Ray-casting point-in-polygon. */
export function pointInPoly(x: number, y: number, poly: readonly Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i] as Pt;
    const pj = poly[j] as Pt;
    if (pi.y > y === pj.y > y) continue;
    const xHit = ((pj.x - pi.x) * (y - pi.y)) / (pj.y - pi.y) + pi.x;
    if (x < xHit) inside = !inside;
  }
  return inside;
}

/** True when every vertex of `poly` is inside the hull (edge-exclusive). */
export function polyInsideHull(poly: readonly Pt[], hull: readonly Pt[]): boolean {
  return poly.every((q) => pointInPoly(q.x, q.y, hull));
}
