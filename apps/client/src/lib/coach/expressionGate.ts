/**
 * Expression gates for the coach face map (plan phase 2 step 4).
 *
 * The honesty problem: face-map pigment is painted over the photo as it was
 * captured, so on an open mouth or a wide smile the soft fills sit across
 * the dark mouth hole or over bunched-up cheeks and read as glow-through.
 * Geometry stays untouched (no reshape, no re-anchor); what changes is the
 * pigment's opacity - faded toward zero where the expression makes pigment
 * dishonest, full strength on a closed, neutral mouth.
 *
 * Two signals, one per source, both optional:
 *
 *   lipOpenness  pure landmark geometry: the inner-lip vertical gap
 *                (13 upper center <-> 14 lower center) over the inner
 *                corner-to-corner width (78 <-> 308). The corner width is
 *                the plan's "equivalent stable scale" - it lives in the
 *                same lip ring, so the ratio is scale- and roll-invariant
 *                and needs nothing beyond the raw mesh. Closed lips leave
 *                the inner ring collapsed to a line (ratio ~0); a wide
 *                open mouth pushes it past 0.5.
 *   blendshapes FaceLandmarker scores (outputFaceBlendshapes: true, IMAGE
 *                mode - the face map is a static photo). jawOpen tracks a
 *                dropped jaw even when the inner ring reads small, and
 *                mouthSmile (mean of Left and Right - one number for the
 *                pair, so a one-sided smirk reads half strength) catches
 *                the big smile no lip metric sees.
 *
 * Fail-open on purpose: an absent or broken signal leaves gain 1 (the
 * closed-mouth default), so a landmarker without blendshapes or a mesh
 * missing one landmark still paints the step-2/3 look. The gate can only
 * remove pigment, never add it.
 *
 * Pure module on purpose: no DOM, no MediaPipe types - unit-testable, and
 * coachOverlay.tsx only multiplies the gain into fillOpacity.
 */

/**
 * Inner-lip landmark indices (canonical mesh): 13 upper center, 14 lower
 * center, 78 / 308 the inner ring's corners.
 */
export const LIP_UPPER_CENTER = 13;
export const LIP_LOWER_CENTER = 14;
export const LIP_CORNER_L = 78;
export const LIP_CORNER_R = 308;

/**
 * Inner-lip aspect ratio: vertical gap between the inner centers over the
 * corner-to-corner width. Null when any of the four landmarks is missing
 * or non-finite, or the corner width is degenerate - callers treat null
 * as "signal absent" (gate open).
 */
export function lipOpenness(
  points: ReadonlyArray<{ x: number; y: number } | undefined> | null | undefined,
): number | null {
  if (!points) return null;
  const a = points[LIP_UPPER_CENTER];
  const b = points[LIP_LOWER_CENTER];
  const c = points[LIP_CORNER_L];
  const d = points[LIP_CORNER_R];
  if (!a || !b || !c || !d) return null;
  const vals = [a.x, a.y, b.x, b.y, c.x, c.y, d.x, d.y];
  if (vals.some((v) => !Number.isFinite(v))) return null;
  const gap = Math.hypot(a.x - b.x, a.y - b.y);
  const width = Math.hypot(c.x - d.x, c.y - d.y);
  if (!(width > 1e-6)) return null;
  const ratio = gap / width;
  return Number.isFinite(ratio) ? ratio : null;
}

/** The two blendshape scores the gate reads; null = signal absent. */
export interface BlendScores {
  jawOpen: number | null;
  mouthSmile: number | null;
}

/** Clamp a raw score to [0, 1]; absent/non-finite reads null. */
function scoreOf(v: unknown): number | null {
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) return null;
  return v > 1 ? 1 : v;
}

/**
 * Pull { jawOpen, mouthSmile } from a FaceLandmarker blendshape category
 * list ({ categoryName, score } rows). mouthSmile is the mean of
 * mouthSmileLeft and mouthSmileRight - either alone still carries, both
 * missing reads null. Pure: takes the plain rows, no MediaPipe types.
 */
export function blendScoresFromCategories(
  categories: ReadonlyArray<{ categoryName?: string; score?: unknown }> | null | undefined,
): BlendScores {
  const out: BlendScores = { jawOpen: null, mouthSmile: null };
  if (!Array.isArray(categories)) return out;
  let smileL: number | null = null;
  let smileR: number | null = null;
  for (const c of categories) {
    if (!c || typeof c.categoryName !== "string") continue;
    if (c.categoryName === "jawOpen" && out.jawOpen === null) out.jawOpen = scoreOf(c.score);
    else if (c.categoryName === "mouthSmileLeft" && smileL === null) smileL = scoreOf(c.score);
    else if (c.categoryName === "mouthSmileRight" && smileR === null) smileR = scoreOf(c.score);
  }
  const smiles = [smileL, smileR].filter((s): s is number => s !== null);
  if (smiles.length > 0) out.mouthSmile = smiles.reduce((a, s) => a + s, 0) / smiles.length;
  return out;
}

/** The three signals the gate consumes; every field is optional. */
export interface ExpressionSignals {
  lipOpenness: number | null;
  jawOpen: number | null;
  mouthSmile: number | null;
}

/** Signal with absent/NaN mapped to null (present values pass through). */
export function expressionSignals(raw: {
  lipOpenness?: unknown;
  jawOpen?: unknown;
  mouthSmile?: unknown;
}): ExpressionSignals {
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  return {
    lipOpenness: num(raw.lipOpenness),
    jawOpen: num(raw.jawOpen),
    mouthSmile: num(raw.mouthSmile),
  };
}

/**
 * One fade curve: gain 1 at/below lo, 0 at/above hi, a smoothstep down
 * between (C1-continuous, no cliff at the knees). A null or NaN signal
 * fails open: gain 1.
 */
export function fadeGain(x: number | null, lo: number, hi: number): number {
  if (x === null || Number.isNaN(x)) return 1;
  if (hi <= lo) return x >= hi ? 0 : 1;
  if (x <= lo) return 1;
  if (x >= hi) return 0;
  const t = (x - lo) / (hi - lo);
  return 1 - t * t * (3 - 2 * t);
}

/**
 * Per-zone gate spec: which signals gate the zone, and where each fade
 * band sits. Zones not in the table are ungated. Thresholds are chosen so
 * resting and conversational faces keep full pigment and only deliberate
 * expressions fade:
 *
 *   lipOpenness   resting closed/parted < 0.2; deliberately open > 0.45
 *   jawOpen       resting < 0.1; dropped jaw 0.5+
 *   mouthSmile    neutral < 0.15; beaming 0.6+
 *
 * Three sensitivities: `lip` (on the lips - cupid_bow) fades first, then
 * `mouth` (the chin and corner-adjacent ribbons), then `cheek` (the
 * apples and tips, which a big smile bunches up but an open mouth alone
 * does not move - no lipOpen entry). Far zones (eyes, forehead, nose,
 * temples, hairline) are ungated.
 */
type GateSpec = Partial<Record<keyof ExpressionSignals, readonly [number, number]>>;

const LIP_CLASS: readonly string[] = ["cupid_bow"];
const MOUTH_CLASS: readonly string[] = [
  "chin_ball", "under_chin", "cheek_shelf_L", "cheek_shelf_R", "jaw_L", "jaw_R",
];
const CHEEK_CLASS: readonly string[] = [
  "cheek_apple_L", "cheek_apple_R", "cheek_tip_L", "cheek_tip_R",
];

const GATES: Readonly<Record<string, GateSpec>> = {
  lip: {
    lipOpenness: [0.2, 0.45],
    jawOpen: [0.3, 0.55],
    mouthSmile: [0.6, 0.85],
  },
  mouth: {
    lipOpenness: [0.35, 0.65],
    jawOpen: [0.45, 0.7],
    mouthSmile: [0.7, 0.92],
  },
  cheek: {
    jawOpen: [0.6, 0.85],
    mouthSmile: [0.5, 0.8],
  },
};

function specIndex(): Record<string, GateSpec> {
  const out: Record<string, GateSpec> = {};
  for (const id of LIP_CLASS) out[id] = GATES.lip!;
  for (const id of MOUTH_CLASS) out[id] = GATES.mouth!;
  for (const id of CHEEK_CLASS) out[id] = GATES.cheek!;
  return out;
}

const SPEC_BY_ZONE: Readonly<Record<string, GateSpec>> = specIndex();

/** The gate spec for a zone id, or null when the zone is ungated. */
export function gateSpec(zoneId: string): GateSpec | null {
  return SPEC_BY_ZONE[zoneId] ?? null;
}

/** The zone ids each sensitivity class covers (test + doc surface). */
export const GATED_ZONES: Readonly<Record<"lip" | "mouth" | "cheek", readonly string[]>> = {
  lip: LIP_CLASS,
  mouth: MOUTH_CLASS,
  cheek: CHEEK_CLASS,
};

/**
 * Pigment gain for one zone under the given signals: the product of the
 * zone's fade curves. Ungated zone, absent signals, or NaN inputs read 1
 * (full pigment); an open-mouth/smile combination can only pull the gain
 * down, and the result is clamped to [0, 1].
 */
export function expressionGain(zoneId: string, signals: ExpressionSignals): number {
  const spec = gateSpec(zoneId);
  if (!spec) return 1;
  let gain = 1;
  const bands: ReadonlyArray<
    readonly [keyof ExpressionSignals, readonly [number, number] | undefined]
  > = [
    ["lipOpenness", spec.lipOpenness],
    ["jawOpen", spec.jawOpen],
    ["mouthSmile", spec.mouthSmile],
  ];
  for (const [key, band] of bands) {
    if (!band) continue;
    gain *= fadeGain(signals[key], band[0], band[1]);
  }
  if (!Number.isFinite(gain) || gain < 0) return 0;
  return gain > 1 ? 1 : gain;
}

/** Expression gates off for this page load: ?exprgate=0|off|false (probe A/B). */
export function expressionGateDisabled(): boolean {
  try {
    const v = new URLSearchParams(window.location.search).get("exprgate");
    return v === "0" || v === "off" || v === "false";
  } catch {
    return false;
  }
}
