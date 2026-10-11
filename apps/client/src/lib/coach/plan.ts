/**
 * CoachPlan: (classification, rules, zones, shades, lock) -> ordered steps.
 *
 * Spec: FACE-GEOMETRY.md section 6. Each step carries the zone ids to
 * glow, a descriptive verb (light/placement, never flaw language), one
 * sentence of copy, the derived shade hex, and the brush direction.
 * Ordered: contour ribbons first, then blush, then highlight - the order
 * a working MUA builds the face.
 */

import rulesJson from "./rules.json" with { type: "json" };
import type { Classification, FaceShape } from "./faceShape.ts";
import { deriveShades, type CoachShades } from "./shades.ts";

export interface RulesFile {
  schema: number;
  school: string;
  verbs: Record<string, string>;
  shapes: Record<
    FaceShape,
    {
      contour?: { ribbons: RibbonId[]; note?: string; source?: string };
      blush?: { zone: string; angle_deg: number; height: string; placement?: string; source?: string };
      brow?: { arch: string; source?: string };
      highlight?: { zones: string[]; source?: string };
    }
  >;
  brushDirections: Record<string, string>;
}

export const rules: RulesFile = rulesJson as unknown as RulesFile;

type RibbonId = string;

export interface CoachStep {
  /** Every zone/ribbon id this step lights up (L+R pairs expand here). */
  zoneIds: string[];
  /** Descriptive verb: lengthen, soften, lift, define, brighten, warm. */
  verb: string;
  /** One sentence, descriptive not corrective. */
  oneSentence: string;
  shadeHex: string;
  brushDirection: string;
}

export interface CoachPlanInput {
  classification: Classification;
  /** Skin hex from the tone step (api skinColor or picker profile). */
  skinHex: string;
  /** The lock hex - blush derives from it, exactly like the server. */
  lockHex: string;
  /** Tone depth 0..1 (server parity: picker idx/5 or 1 - 1.15*luminance). */
  depth: number;
  /** Oily signal: matte finish, no dewy highlight (existing oilyRule semantics). */
  oily?: boolean;
}

/** Flaw-language guard: a step that trips this is a bug, not a style call. */
const FORBIDDEN_COPY = /\b(fix|slim|problem|flaw|reduce|correct|hide|disguise|narrow|shrink|minimize)\b/i;

function step(verb: string, sentence: string): CoachStep {
  if (FORBIDDEN_COPY.test(sentence)) {
    throw new Error(`copy violates the descriptive stance: ${sentence}`);
  }
  const trimmed = sentence.endsWith(".") ? sentence : `${sentence}.`;
  return { zoneIds: [], verb, oneSentence: trimmed, shadeHex: "#000000", brushDirection: "" };
}

/**
 * Build the ordered plan. Falls back to the oval rules for unknown shapes
 * (never gate a user out of the product).
 */
export function buildPlan(input: CoachPlanInput): CoachStep[] {
  const { classification } = input;
  const shape: FaceShape = rules.shapes[classification.primary] ? classification.primary : "oval";
  const spec = rules.shapes[shape];
  const shades: CoachShades = deriveShades(input.skinHex, input.lockHex, input.depth);
  const steps: CoachStep[] = [];

  // 1. contour ribbons
  if (spec.contour && spec.contour.ribbons.length > 0) {
    const s = step(rules.verbs.contour ?? "define", spec.contour.note ?? "Trace the light along the lines, one side at a time.");
    s.zoneIds = spec.contour.ribbons.slice();
    s.shadeHex = input.oily ? shades.contour : shades.contour;
    s.brushDirection = spec.contour.ribbons
      .map((r) => rules.brushDirections[r] ?? "along the line, feathered")
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ");
    steps.push(s);
  }

  // 2. blush
  if (spec.blush) {
    const height = spec.blush.height === "high" ? "high on the cheekbone" : spec.blush.height === "low" ? "lower, near the apples" : "at the apples";
    const angle = spec.blush.angle_deg >= 20 ? "swept up toward the temple" : spec.blush.angle_deg <= 8 ? "level with the floor" : "angled gently up";
    const s = step(rules.verbs.warm ?? "warm", `Place blush ${height}, ${angle}.`);
    const zone = spec.blush.zone;
    s.zoneIds = [`${zone}_L`, `${zone}_R`];
    s.shadeHex = shades.blush;
    s.brushDirection = rules.brushDirections[zone] ?? "outward from the apples";
    steps.push(s);
  }

  // 3. brow (placement note only; the client never reshapes a brow)
  if (spec.brow) {
    const s = step("define", `Work with the brow's natural ${spec.brow.arch === "flat" ? "flat line" : `${spec.brow.arch} arch`}.`);
    s.zoneIds = [];
    s.shadeHex = shades.brow;
    s.brushDirection = "hair by hair, outer third last";
    steps.push(s);
  }

  // 4. highlight (oily skin: kept matte, matching the server's oil rule)
  if (spec.highlight && !input.oily) {
    const s = step(rules.verbs.brighten ?? "brighten", "Touch light where the face naturally catches it.");
    s.zoneIds = spec.highlight.zones.slice();
    s.shadeHex = shades.highlight;
    s.brushDirection = spec.highlight.zones
      .map((z) => rules.brushDirections[z] ?? "tap, don't swipe")
      .filter((v, i, a) => a.indexOf(v) === i)
      .join("; ");
    steps.push(s);
  } else if (spec.highlight && input.oily) {
    const s = step("define", "Kept matte - the light steps skip glow on oily skin.");
    s.zoneIds = [];
    s.shadeHex = shades.highlight;
    s.brushDirection = "none";
    steps.push(s);
  }

  return steps;
}
