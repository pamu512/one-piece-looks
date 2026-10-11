/**
 * The look builder: turns (lock, skin type, tone, mood, event, seed) into
 * exactly three looks — Anchor, Lift, Statement — as makeup-vto effect sets.
 *
 * Rules encoded here (from the product spec):
 * - Always three looks, always these roles and names.
 * - The locked category renders with the on-face hex, in every look.
 * - Mood + event move intensity and pattern family ONLY; never the lock.
 * - Oily (whole or T-zone) forces a less dewy cheek inside any mood/event.
 * - Shuffle re-rolls supporting layers only (new seed), lock/mood/event stay.
 * - Contour pattern names are labels from contour.json; every pattern name is
 *   checked against its vendored catalog.
 */

import {
  CONTOUR_PATTERNS,
  HIGHLIGHTER_PATTERNS,
  BLUSH_ENTRIES,
  EYESHADOW_ENTRIES,
  EYELINER_ENTRIES,
  EYEBROWS_ENTRIES,
} from "../youcam/patterns.js";
import type { VtoEffect } from "../youcam/client.js";
import {
  classifyFamily,
  hexToRgb,
  luminance,
  mix,
  rgbToHex,
  clamp,
  shiftHue,
} from "../domain/color.js";
import type {
  Category,
  Event,
  Look,
  LookRole,
  Mood,
  RecipeChip,
  SkinType,
  Tone,
} from "../domain/types.js";
import { LOOK_ROLES } from "../domain/types.js";

// ---------------------------------------------------------------------------
// Deterministic PRNG (mulberry32): same seed -> same looks; shuffle = new seed.
// ---------------------------------------------------------------------------

export function seedFrom(...parts: (string | number)[]): number {
  let h = 0x811c9dc5;
  const s = parts.join("|");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// Inputs the builder needs
// ---------------------------------------------------------------------------

export interface BuildInput {
  lock: { category: Category; onFaceHex: string; productHex: string; unverified: boolean };
  skinType: SkinType;
  tone: Tone;
  mood: Mood;
  event: Event;
  /** Changes on shuffle; sessionId+shuffleCount on the server side. */
  seed: number;
}

export interface BuiltLook {
  role: LookRole;
  effects: VtoEffect[];
  chips: RecipeChip[];
  /** Categories this look adds beyond the locked one. */
  addsCategories: Category[];
  lockApproximated: boolean;
}

// ---------------------------------------------------------------------------
// Mood/event model: intensity + pattern family
// ---------------------------------------------------------------------------

interface Vibe {
  /** 0..1 overall intensity multiplier for supporting layers. */
  intensity: number;
  /** Pattern family for eye layers. */
  eye: "natural" | "soft" | "smokey" | "winged" | "dramatic";
  /** Cheek finish bias before the oil rule. */
  cheek: "barely" | "fresh" | "warm" | "sculpted";
  /** Lip texture bias for UNLOCKED lip layers only (locked lip keeps its hex). */
  lipTexture: "matte" | "satin" | "gloss";
}

const MOOD_VIBES: Record<Mood, Partial<Vibe>> = {
  "Bitch mode": { intensity: +0.18, eye: "dramatic", cheek: "sculpted", lipTexture: "matte" },
  Boss: { intensity: +0.06, eye: "winged", cheek: "sculpted", lipTexture: "matte" },
  Demure: { intensity: -0.16, eye: "soft", cheek: "fresh", lipTexture: "satin" },
  "Owning it": { intensity: +0.12, eye: "smokey", cheek: "warm", lipTexture: "matte" },
  Sexy: { intensity: +0.08, eye: "smokey", cheek: "warm", lipTexture: "gloss" },
  Soft: { intensity: -0.18, eye: "soft", cheek: "fresh", lipTexture: "satin" },
  Clean: { intensity: -0.12, eye: "natural", cheek: "barely", lipTexture: "satin" },
  "Main character": { intensity: +0.14, eye: "dramatic", cheek: "warm", lipTexture: "gloss" },
};

const EVENT_VIBES: Record<Event, Partial<Vibe>> = {
  "Dinner date": { intensity: +0.06, eye: "soft", lipTexture: "gloss" },
  Office: { intensity: -0.12, eye: "natural", cheek: "barely", lipTexture: "matte" },
  Casual: { intensity: -0.04, eye: "natural" },
  Workout: { intensity: -0.14, eye: "natural", cheek: "barely", lipTexture: "matte" },
  "Night out": { intensity: +0.14, eye: "smokey" },
  "Wedding guest": { intensity: +0.02, eye: "soft", cheek: "fresh", lipTexture: "gloss" },
  Errands: { intensity: -0.1, eye: "natural", cheek: "barely" },
  Interview: { intensity: -0.06, eye: "natural", cheek: "sculpted", lipTexture: "matte" },
};

const ROLE_INTENSITY: Record<LookRole, number> = {
  anchor: 0.18,
  lift: 0.5,
  statement: 0.92,
};

function resolveVibe(mood: Mood, event: Event, role: LookRole): Vibe {
  const m = MOOD_VIBES[mood];
  const e = EVENT_VIBES[event];
  const intensity = clamp(ROLE_INTENSITY[role] + (m.intensity ?? 0) + (e.intensity ?? 0), 0.08, 1);
  return {
    intensity,
    eye: (m.eye ?? e.eye ?? "natural") as Vibe["eye"],
    cheek: (m.cheek ?? e.cheek ?? "fresh") as Vibe["cheek"],
    lipTexture: (m.lipTexture ?? e.lipTexture ?? "satin") as Vibe["lipTexture"],
  };
}

/** The oil rule: any oily signal (whole or T-zone) forces a less dewy cheek. */
export function oilyRule(skinType: SkinType): boolean {
  return skinType === "Oily" || skinType === "Oily & Redness" || skinType === "Combination" || skinType === "Combination & Redness";
}

// ---------------------------------------------------------------------------
// Tone helpers
// ---------------------------------------------------------------------------

export interface ToneProfile {
  depth: number; // 0..1, higher = deeper
  temperature: "warm" | "neutral" | "cool";
  skinHex: string; // representative skin hex for contour/brow derivation
}

const PICKER_DEPTH_HEX: Record<string, string> = {
  "01": "#f6dbc4",
  "02": "#eec5a4",
  "03": "#ddab84",
  "04": "#c28e6b",
  "05": "#a4714f",
  "06": "#7d523a",
};

export function toneProfile(tone: Tone): ToneProfile {
  if (tone.source === "api") {
    const { r, g, b } = hexToRgb(tone.skinColor);
    const lum = luminance(tone.skinColor);
    const warmth = (r - b) / 255; // >0 warm, <0 cool
    const temperature: ToneProfile["temperature"] =
      warmth > 0.16 ? "warm" : warmth < 0.04 ? "cool" : "neutral";
    return { depth: clamp(1 - lum * 1.15, 0, 1), temperature, skinHex: tone.skinColor };
  }
  const skinHex = PICKER_DEPTH_HEX[tone.depth] ?? "#c28e6b";
  const idx = parseInt(tone.depth, 10) - 1;
  return { depth: clamp(idx / 5, 0, 1), temperature: tone.temperature, skinHex };
}

// ---------------------------------------------------------------------------
// Pattern pools, grounded in the vendored catalogs
// ---------------------------------------------------------------------------

function poolByTags(
  entries: ReadonlyMap<string, { label: string; tags?: { name: string }[] }>,
  want: readonly string[],
): string[] {
  const out: string[] = [];
  for (const e of entries.values()) {
    if ((e.tags ?? []).some((t) => want.includes(t.name))) out.push(e.label);
  }
  return out;
}

const SHADOW_POOLS: Record<Vibe["eye"], string[]> = {
  natural: poolByTags(EYESHADOW_ENTRIES, ["Only upper lid", "Fan shape"]),
  soft: poolByTags(EYESHADOW_ENTRIES, ["Dream", "Fan shape"]),
  smokey: poolByTags(EYESHADOW_ENTRIES, ["Smokey eye"]),
  winged: poolByTags(EYESHADOW_ENTRIES, ["Cat eye", "Smokey eye"]),
  dramatic: poolByTags(EYESHADOW_ENTRIES, ["Dramatic", "Smokey eye", "Cat eye"]),
};

const LINER_POOLS: Record<Vibe["eye"], string[]> = {
  natural: poolByTags(EYELINER_ENTRIES, ["Upper", "Half eye"]),
  soft: poolByTags(EYELINER_ENTRIES, ["Upper", "Half eye"]),
  smokey: poolByTags(EYELINER_ENTRIES, ["Smoke", "Whole eye"]),
  winged: poolByTags(EYELINER_ENTRIES, ["Open Wings", "Drama"]),
  dramatic: poolByTags(EYELINER_ENTRIES, ["Drama", "Arabic", "Open Wings"]),
};

const BLUSH_PLACEMENTS = {
  barely: ["Circle", "Round"],
  fresh: ["Round", "Circle"],
  warm: ["Oblique", "Rectangle"],
  sculpted: ["Oblique", "Triangle"],
} as const;

function blushPool(cheek: Vibe["cheek"]): string[] {
  const want = BLUSH_PLACEMENTS[cheek];
  const out: string[] = [];
  for (const e of BLUSH_ENTRIES.values()) {
    const tags = (e.tags ?? []).map((t) => t.name);
    if (want.some((w) => tags.includes(w))) out.push(e.label);
  }
  return out;
}

const LASH_POOLS: Record<Vibe["eye"], string[]> = {
  natural: ["Natural1", "Natural2", "Natural3"],
  soft: ["Natural1", "Wispies1", "Wispies2"],
  smokey: ["UpperDense1", "Upper&Lower1", "UpperDense2"],
  winged: ["Winged1", "Winged2", "Wispies1"],
  dramatic: ["Winged1", "UpperDense2", "Upper&Lower2"],
};

const BROW_BY_TEMP: Record<ToneProfile["temperature"], string> = {
  warm: "SoftArch1",
  neutral: "SoftArch2",
  cool: "SoftArch3",
};

// ---------------------------------------------------------------------------
// Palette derivation
// ---------------------------------------------------------------------------

/** Supporting-layer colors harmonized with the lock and the tone. */
function palettes(lockHex: string, tone: ToneProfile, family: ReturnType<typeof classifyFamily>) {
  const skin = tone.skinHex;
  const contour = mix(skin, "#5c3a28", 0.35 + tone.depth * 0.2);
  const highlight = mix(skin, "#fff3e2", 0.4 - tone.depth * 0.15);
  const brow = mix(skin, "#2f1c10", 0.55 + tone.depth * 0.15);

  // Cheek follows the lock family but sits softer and warmer.
  const cheekBase =
    family === "pink" || family === "berry" || family === "plum" || family === "mauve"
      ? shiftHue(lockHex, -18)
      : family === "peach" || family === "coral" || family === "orange"
        ? shiftHue(lockHex, -8)
        : mix(lockHex, "#e8a598", 0.5);
  const cheek = mix(cheekBase, skin, 0.15);

  // Eye neutrals derive from the lock, deepened for definition.
  const eye = mix(lockHex, "#4a3020", 0.45);
  const eyeLight = mix(lockHex, skin, 0.55);
  const liner = mix("#1d1410", lockHex, 0.18);

  return { skin, contour, highlight, brow, cheek, eye, eyeLight, liner };
}

// ---------------------------------------------------------------------------
// Effect constructors (all pattern names checked against catalogs)
// ---------------------------------------------------------------------------

function lipEffect(hex: string, texture: Vibe["lipTexture"], intensity: number, oily: boolean): VtoEffect {
  const tex = oily && texture === "gloss" ? "satin" : texture;
  const palette: Record<string, unknown> = {
    color: hex,
    texture: tex,
    colorIntensity: Math.round(60 + intensity * 30),
  };
  if (tex === "gloss") {
    palette.gloss = Math.round(45 + intensity * 30);
    palette.transparencyIntensity = 40;
  }
  return {
    category: "lip_color",
    shape: { name: "original" },
    style: { type: "full" },
    palettes: [palette],
  };
}

function blushEffect(pattern: string, hex: string, intensity: number, oily: boolean): VtoEffect {
  return {
    category: "blush",
    pattern: { name: pattern },
    palettes: [
      {
        color: hex,
        texture: oily ? "matte" : "satin",
        ...(oily ? {} : { glowStrength: Math.round(30 + intensity * 20) }),
        colorIntensity: Math.round(35 + intensity * 35),
      },
    ],
  };
}

function shadowEffect(pattern: string, hexes: string[], intensity: number): VtoEffect {
  // Live engine rejects palettes longer than the pattern's colorNum
  // (pinned 2026-10-02: 1color137 + 2 palettes -> invalid_parameter).
  const n = shadowPaletteSize(pattern);
  return {
    category: "eye_shadow",
    pattern: { name: pattern },
    palettes: hexes.slice(0, n).map((color, i) => ({
      color,
      texture: "matte",
      colorIntensity: Math.round(30 + intensity * 40 - i * 8),
    })),
  };
}

function linerEffect(pattern: string, hex: string, intensity: number): VtoEffect {
  return {
    category: "eye_liner",
    pattern: { name: pattern },
    palettes: [{ color: hex, texture: "matte", colorIntensity: Math.round(45 + intensity * 40) }],
  };
}

function browEffect(pattern: string, hex: string, intensity: number): VtoEffect {
  return {
    // Live engine accepts only the category const "eyebrows" (not "brow"):
    // "brow" -> 400 oneOf validation at task create (live-pinned 2026-10-05,
    // docs.perfectcorp.com makeup-vto effect schema).
    category: "eyebrows",
    // Live engine rejects shape patterns that set definition without curvature
    // AND thickness (pinned 2026-10-02: definition-only -> invalid_parameter).
    pattern: {
      type: "shape",
      name: pattern,
      curvature: Math.round(10 * intensity),
      thickness: Math.round(5 * intensity),
      definition: Math.round(40 + intensity * 35),
    },
    palettes: [{ color: hex, texture: "matte", colorIntensity: Math.round(45 + intensity * 35) }],
  };
}

function lashEffect(pattern: string, hex: string, intensity: number): VtoEffect {
  return {
    category: "eyelashes",
    pattern: { name: pattern },
    palettes: [{ color: hex, colorIntensity: Math.round(40 + intensity * 40) }],
  };
}

function contourEffect(pattern: string, hex: string, intensity: number): VtoEffect {
  return {
    category: "contour",
    pattern: { name: pattern },
    palettes: [{ color: hex, colorIntensity: Math.round(25 + intensity * 35) }],
  };
}

function highlightEffect(pattern: string, hex: string, intensity: number, oily: boolean): VtoEffect {
  return {
    category: "highlighter",
    pattern: { name: pattern },
    palettes: [
      {
        color: hex,
        glowIntensity: Math.round(oily ? 20 + intensity * 15 : 35 + intensity * 25),
        shimmerIntensity: Math.round(oily ? 15 : 35 + intensity * 20),
        shimmerDensity: Math.round(oily ? 12 : 30),
        shimmerSize: 25,
        colorIntensity: Math.round(25 + intensity * 25),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// The builder
// ---------------------------------------------------------------------------

function pick<T>(rng: () => number, pool: readonly T[]): T {
  if (pool.length === 0) throw new Error("empty pattern pool");
  return pool[Math.floor(rng() * pool.length)] as T;
}

function shadowPaletteSize(pattern: string): number {
  const e = EYESHADOW_ENTRIES.get(pattern);
  const n = e?.colorNum ?? 1;
  return clamp(n, 1, 4);
}

const CONTOUR_DEFAULT = "OvalFace6";
const HIGHLIGHT_DEFAULT = "OvalFace2";

/** Build one look's effects + chips. Pure: same input -> same output. */
export function buildLook(input: BuildInput, role: LookRole): BuiltLook {
  const rng = mulberry32(seedFrom(input.seed, role));
  const vibe = resolveVibe(input.mood, input.event, role);
  const oily = oilyRule(input.skinType);
  const tone = toneProfile(input.tone);
  const family = classifyFamily(input.lock.onFaceHex);
  const pal = palettes(input.lock.onFaceHex, tone, family);

  const effects: VtoEffect[] = [];
  const chips: RecipeChip[] = [];
  const adds: Category[] = [];
  const lockHex = input.lock.onFaceHex;

  const chip = (label: string, detail: string, hex: string) => chips.push({ label, detail, hex });

  // The lock, always first, always its own hex.
  switch (input.lock.category) {
    case "lip":
      effects.push(lipEffect(lockHex, vibe.lipTexture, Math.max(vibe.intensity, 0.55), oily));
      chip("Lip", `${family} - locked`, lockHex);
      break;
    case "cheek":
      effects.push(blushEffect(pick(rng, blushPool(vibe.cheek)), lockHex, Math.max(vibe.intensity, 0.5), oily));
      chip("Cheek", `${family} - locked`, lockHex);
      break;
    case "eye":
      effects.push(shadowEffect(pick(rng, SHADOW_POOLS[vibe.eye]), [lockHex, pal.eyeLight], Math.max(vibe.intensity, 0.5)));
      chip("Eye", `${family} - locked`, lockHex);
      break;
    case "brow":
      effects.push(browEffect(BROW_BY_TEMP[tone.temperature], lockHex, Math.max(vibe.intensity, 0.5)));
      chip("Brow", `${family} - locked`, lockHex);
      break;
    case "liner":
      effects.push(linerEffect(pick(rng, LINER_POOLS[vibe.eye]), lockHex, Math.max(vibe.intensity, 0.5)));
      chip("Liner", `${family} - locked`, lockHex);
      break;
  }

  const not = (c: Category) => c !== input.lock.category;
  const i = vibe.intensity;

  if (role === "anchor") {
    // Locked piece, near-bare rest. Honest stance: no smoothing, ever.
  } else if (role === "lift") {
    // The nameable step (verdict P0-1, 2026-10-07): lash + brow definition
    // and a blush raised onto the cheekbone. A viewer can verbalize "eyes
    // opened up, cheeks lifted" - not just an opacity nudge. The locked
    // category is never doubled; seeded variety lives in the extra wash.
    if (not("brow")) {
      effects.push(browEffect(BROW_BY_TEMP[tone.temperature], pal.brow, i * 0.7));
      chip("Brow", "soft definition", pal.brow);
      adds.push("brow");
    }
    effects.push(lashEffect(pick(rng, LASH_POOLS[vibe.eye]), "#1a1010", i * 0.85));
    chip("Lash", `${vibe.eye} definition`, "#1a1010");
    adds.push("eye");
    if (not("cheek")) {
      effects.push(blushEffect(pick(rng, blushPool(vibe.cheek)), pal.cheek, Math.max(i * 0.9, 0.34), oily));
      chip("Cheek", vibe.cheek, pal.cheek);
      adds.push("cheek");
    }
    const extras: Category[] = (["liner", "eye"] as Category[]).filter(not);
    if (i > 0.55 && extras.length > 0) {
      const c = extras[Math.floor(rng() * extras.length)]!;
      if (c === "liner") {
        effects.push(linerEffect(pick(rng, LINER_POOLS[vibe.eye]), pal.liner, i * 0.8));
        chip("Liner", vibe.eye, pal.liner);
      } else {
        effects.push(shadowEffect(pick(rng, SHADOW_POOLS[vibe.eye]), [pal.eye, pal.eyeLight], i * 0.7));
        chip("Eye", `${vibe.eye} wash`, pal.eye);
      }
      adds.push(c);
    }
  } else {
    // Statement: locked piece plus the full pattern set.
    // Honest stance: no smoothing unshift here - renders are unretouched.
    const contourPattern = CONTOUR_PATTERNS.includes(CONTOUR_DEFAULT)
      ? CONTOUR_DEFAULT
      : (CONTOUR_PATTERNS[0] as string);
    effects.push(contourEffect(contourPattern, pal.contour, i));
    chip("Contour", "sculpt", pal.contour);
    if (not("cheek")) {
      effects.push(blushEffect(pick(rng, blushPool(vibe.cheek)), pal.cheek, i, oily));
      chip("Cheek", vibe.cheek, pal.cheek);
      adds.push("cheek");
    }
    if (not("eye")) {
      const shadowPattern = pick(rng, SHADOW_POOLS[vibe.eye]);
      const n = shadowPaletteSize(shadowPattern);
      const hexes = [pal.eye, pal.eyeLight, mix(pal.eye, "#000000", 0.3), mix(pal.eyeLight, "#ffffff", 0.2)].slice(0, n);
      effects.push(shadowEffect(shadowPattern, hexes, i));
      chip("Eye", vibe.eye, pal.eye);
      adds.push("eye");
    }
    if (not("liner")) {
      effects.push(linerEffect(pick(rng, LINER_POOLS[vibe.eye]), pal.liner, i));
      chip("Liner", vibe.eye, pal.liner);
      adds.push("liner");
    }
    if (not("brow")) {
      effects.push(browEffect(BROW_BY_TEMP[tone.temperature], pal.brow, i));
      chip("Brow", "defined", pal.brow);
      adds.push("brow");
    }
    effects.push(lashEffect(pick(rng, LASH_POOLS[vibe.eye]), "#1a1010", i));
    chip("Lash", vibe.eye, "#1a1010");
    adds.push("eye");
    if (!oily) {
      const hl = HIGHLIGHTER_PATTERNS.includes(HIGHLIGHT_DEFAULT)
        ? HIGHLIGHT_DEFAULT
        : (HIGHLIGHTER_PATTERNS[0] as string);
      effects.push(highlightEffect(hl, pal.highlight, i, oily));
      chip("Highlight", "glow", pal.highlight);
    } else {
      chip("Highlight", "kept matte (oily T-zone)", pal.highlight);
    }
  }

  return { role, effects, chips, addsCategories: [...new Set(adds)], lockApproximated: false };
}

/** Build all three looks. */
export function buildLooks(input: BuildInput): BuiltLook[] {
  return LOOK_ROLES.map((role) => buildLook(input, role));
}

/** Client-facing Look assembly once renders exist. */
export function assembleLook(
  built: BuiltLook,
  imageUrl: string,
  shopLinks: Partial<Record<Category, { label: string; url: string }>> = {},
): Look {
  const firstAdd = built.addsCategories.find((c) => shopLinks[c]);
  return {
    role: built.role,
    imageUrl,
    chips: built.chips,
    ...(firstAdd ? { shop: shopLinks[firstAdd] } : {}),
    lockApproximated: built.lockApproximated,
  };
}

export { rgbToHex };
