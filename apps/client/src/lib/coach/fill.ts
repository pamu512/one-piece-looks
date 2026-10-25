/**
 * Zone-fill compositing policy for the coach face map.
 *
 * The sticker problem (plan phase 2 step 2): a flat alpha polygon over the
 * photo reads as a plastic hologram sticker. It flattens skin texture to
 * (1 - alpha) of its own energy and ignores the skin's luminance - on deep
 * skin a contour shade can even lighten, because the fill never multiplies
 * with what is underneath. Real pigment sits ON skin: shade and bronzer
 * darken through the skin's own luminance (multiply), blush and eyeshadow
 * stain it while every ridge still catches the light (soft-light), and no
 * brush ever leaves a die-cut edge, so every fill feathers out as a
 * gaussian.
 *
 * Pure module on purpose: no DOM, no React - the mapping is unit-testable
 * and coachOverlay.tsx only turns it into SVG attributes.
 */

/** How one step's pigment composites with the photo beneath it. */
export type FillBlend = "multiply" | "soft-light";

/**
 * Fill opacity per step verb. Depth strengths carry over from the flat
 * era; the pigment verbs run hotter because soft-light is gentler than
 * flat alpha - probe-measured (demos/probe-soft-fills.mjs): blush at 0.5
 * shifted the cheek core by only |dRGB| 3.3, under the 4-visibility floor.
 */
export const VERB_FILL: Record<string, number> = {
  contour: 0.55,
  warm: 0.7,
  define: 0.5,
  brighten: 0.6,
};

/**
 * Depth verbs (contour/bronzer, and the brow shade, which fills no zone)
 * composite through multiply so the skin's own luminance shows through the
 * shade. Pigment verbs (blush, highlight, eyeshadow) go through soft-light
 * so texture and light stay visible under the color. Unknown verbs default
 * to soft-light; "screen" stays reserved for a gloss finish, which no
 * current step has.
 */
export function blendForVerb(verb: string): FillBlend {
  return verb === "contour" || verb === "define" ? "multiply" : "soft-light";
}

/** Used when a step verb has no entry in VERB_FILL. */
export const FILL_OPACITY_FALLBACK = 0.45;

/**
 * All-steps view stacks every layer on the photo, so each one is pulled back.
 * A single step keeps the verb strength.
 */
export const ALL_STEPS_GAIN = 0.7;

const PAINT_HEX = /^#[0-9a-fA-F]{6}$/;

/** Verb strength in (0, 1]. Unknown or non-finite verbs use the fallback. */
export function fillOpacity(verb: string): number {
  const op = VERB_FILL[verb];
  if (typeof op !== "number" || !Number.isFinite(op) || op <= 0 || op > 1) return FILL_OPACITY_FALLBACK;
  return op;
}

/** #RRGGBB, or null when the shade cannot be painted. */
export function paintHex(hex: unknown): string | null {
  if (typeof hex !== "string" || !PAINT_HEX.test(hex.trim())) return null;
  return hex.trim().toLowerCase();
}

/**
 * Rules name a stem (`cheek_apple`). The contour map stores `cheek_apple_L`
 * and `cheek_apple_R`. An id that already exists is used as-is.
 */
export function resolvePaintIds(id: string, known: ReadonlySet<string>): string[] {
  if (typeof id !== "string" || id.length === 0) return [];
  if (known.has(id)) return [id];
  const out: string[] = [];
  if (known.has(`${id}_L`)) out.push(`${id}_L`);
  if (known.has(`${id}_R`)) out.push(`${id}_R`);
  return out;
}

export interface PaintStep {
  verb?: unknown;
  shadeHex?: unknown;
  zoneIds?: unknown;
}

export interface PaintShape {
  id: string;
  kind?: unknown;
  radiusIod?: unknown;
  widthMaxIod?: unknown;
}

export interface PigmentLayer {
  zoneId: string;
  fill: string;
  opacity: number;
  blend: FillBlend;
  sigma: number;
}

export interface GuideLayer {
  zoneId: string;
  stroke: string;
}

/**
 * Pigment layers in step order (later steps stack; a shared zone is not dropped).
 * Guides are one per zone, stroked with the last step that painted it, and
 * carry no blend: the caller draws them after every pigment.
 * A bad hex, a missing zone list, or an unknown id paints nothing for that entry.
 */
export function zoneLayers(
  steps: readonly PaintStep[] | null | undefined,
  shapes: readonly PaintShape[],
  iod: number,
  vbW: number,
  allSteps: boolean,
): { pigments: PigmentLayer[]; guides: GuideLayer[] } {
  const known = new Set(shapes.map((s) => s.id));
  const byShape = new Map(shapes.map((s) => [s.id, s]));
  const pigments: PigmentLayer[] = [];
  const guideStroke = new Map<string, string>();
  const gain = allSteps ? ALL_STEPS_GAIN : 1;
  for (const s of Array.isArray(steps) ? steps : []) {
    if (!s || typeof s !== "object") continue;
    const hex = paintHex(s.shadeHex);
    if (!hex) continue;
    const verb = typeof s.verb === "string" ? s.verb : "";
    const opacity = Math.min(1, fillOpacity(verb) * gain);
    const blend = blendForVerb(verb);
    const rawIds = Array.isArray(s.zoneIds) ? s.zoneIds : [];
    const painted = new Set<string>();
    for (const raw of rawIds) {
      if (typeof raw !== "string") continue;
      for (const zoneId of resolvePaintIds(raw, known)) {
        if (painted.has(zoneId)) continue;
        painted.add(zoneId);
        const shape = byShape.get(zoneId);
        if (!shape) continue;
        pigments.push({
          zoneId,
          fill: hex,
          opacity,
          blend,
          sigma: featherSigmaVb(charRadiusIod(shape), iod, vbW),
        });
        guideStroke.set(zoneId, hex);
      }
    }
  }
  const guides: GuideLayer[] = [];
  for (const [zoneId, stroke] of guideStroke) guides.push({ zoneId, stroke });
  return { pigments, guides };
}

/** SVG points string. Fewer than 3 vertices, or any non-finite coordinate, paints nothing. */
export function pointsAttr(coords: readonly { x: number; y: number }[]): string | null {
  if (coords.length < 3) return null;
  const parts: string[] = [];
  for (const p of coords) {
    if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) return null;
    parts.push(`${p.x.toFixed(1)},${p.y.toFixed(1)}`);
  }
  return parts.join(" ");
}

/** Gaussian feather sigma as a fraction of the shape's characteristic radius. */
export const FEATHER_FRACTION = 0.3;

/** Feather sigma clamps, in coach viewBox units (viewBox is 1000 wide). */
export const FEATHER_MIN_VB = 2.5;
export const FEATHER_MAX_VB = 30;

/**
 * A shape's characteristic radius in IOD units: the zone gaussian radius
 * hint, or half the ribbon's max half-width (ribbonPolygon offsets by
 * widthMaxIod * 0.5). Structural input so both Zone and Ribbon fit.
 */
export function charRadiusIod(shape: { kind?: unknown; radiusIod?: unknown; widthMaxIod?: unknown }): number {
  const r = shape.kind === "ribbon"
    ? num(shape.widthMaxIod) / 2
    : num(shape.radiusIod);
  return Number.isFinite(r) && r > 0 ? r : 0;
}

function num(v: unknown): number {
  return typeof v === "number" ? v : Number.NaN;
}

/**
 * Gaussian feather sigma for one zone/ribbon, in coach viewBox units.
 * `radiusIod` is the shape's characteristic radius (see charRadiusIod),
 * `iod` the face's interocular distance in frame fractions, `vbW` the
 * viewBox width (radius and iod are both x-axis quantities, so the
 * conversion matches how the polygons themselves are drawn). Degenerate
 * inputs fall back to the minimum clamp so a shape always gets a soft
 * edge, never a hard one and never NaN.
 */
export function featherSigmaVb(radiusIod: number, iod: number, vbW: number): number {
  const r = [radiusIod, iod, vbW].every((v) => Number.isFinite(v) && v > 0) ? radiusIod * iod * vbW : 0;
  const sigma = FEATHER_FRACTION * r;
  if (!Number.isFinite(sigma)) return FEATHER_MIN_VB;
  return Math.min(FEATHER_MAX_VB, Math.max(FEATHER_MIN_VB, sigma));
}
