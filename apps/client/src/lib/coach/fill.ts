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
