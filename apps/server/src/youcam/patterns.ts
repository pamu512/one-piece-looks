/**
 * Pattern allowlists loaded from the official YouCam pattern catalogs.
 *
 * Every pattern name the app sends to makeup-vto must be a `label` from the
 * corresponding catalog JSON (contour.json, blush.json, ...). The catalogs are
 * vendored under src/patterns/ so the allowlist is checkable offline and tests
 * fail loudly if a name drifts.
 */

import blush from "../patterns/blush.json" with { type: "json" };
import bronzer from "../patterns/bronzer.json" with { type: "json" };
import contour from "../patterns/contour.json" with { type: "json" };
import eyebrows from "../patterns/eyebrows.json" with { type: "json" };
import eyelashes from "../patterns/eyelashes.json" with { type: "json" };
import eyeliner from "../patterns/eyeliner.json" with { type: "json" };
import eyeshadow from "../patterns/eyeshadow.json" with { type: "json" };
import highlighter from "../patterns/highlighter.json" with { type: "json" };
import lipliner from "../patterns/lipliner.json" with { type: "json" };
import lipshape from "../patterns/lipshape.json" with { type: "json" };

export interface PatternEntry {
  category: string;
  label: string;
  thumbnail: string;
  tags?: { id: number; name: string }[];
  colorNum?: number;
}

function labels(list: unknown, file: string): readonly string[] {
  if (!Array.isArray(list)) throw new Error(`pattern catalog ${file} is malformed`);
  const out = list.map((e) => {
    if (typeof e === "object" && e !== null && typeof (e as PatternEntry).label === "string") {
      return (e as PatternEntry).label;
    }
    throw new Error(`pattern catalog ${file} has an entry without a label`);
  });
  if (out.length === 0) throw new Error(`pattern catalog ${file} is empty`);
  return out;
}

export const BLUSH_PATTERNS = labels(blush, "blush.json");
export const BRONZER_PATTERNS = labels(bronzer, "bronzer.json");
export const CONTOUR_PATTERNS = labels(contour, "contour.json");
export const EYEBROWS_PATTERNS = labels(eyebrows, "eyebrows.json");
export const EYELASHES_PATTERNS = labels(eyelashes, "eyelashes.json");
export const EYELINER_PATTERNS = labels(eyeliner, "eyeliner.json");
export const EYESHADOW_PATTERNS = labels(eyeshadow, "eyeshadow.json");
export const HIGHLIGHTER_PATTERNS = labels(highlighter, "highlighter.json");
export const LIPLINER_PATTERNS = labels(lipliner, "lipliner.json");
export const LIPSHAPES = labels(lipshape, "lipshape.json");

/** Full entries where the builder needs tags/colorNum, keyed by label. */
export function entryMap(list: unknown, file: string): ReadonlyMap<string, PatternEntry> {
  if (!Array.isArray(list)) throw new Error(`pattern catalog ${file} is malformed`);
  return new Map(
    list.map((e) => {
      const entry = e as PatternEntry;
      if (typeof entry.label !== "string") throw new Error(`${file}: entry without label`);
      return [entry.label, entry];
    }),
  );
}

export const BLUSH_ENTRIES = entryMap(blush, "blush.json");
export const EYESHADOW_ENTRIES = entryMap(eyeshadow, "eyeshadow.json");
export const EYELINER_ENTRIES = entryMap(eyeliner, "eyeliner.json");
export const EYEBROWS_ENTRIES = entryMap(eyebrows, "eyebrows.json");

/** Assert a pattern name is in an allowlist; throws with a helpful message. */
export function requirePattern(name: string, allow: readonly string[], catalog: string): string {
  if (!allow.includes(name)) {
    throw new Error(
      `pattern "${name}" is not a label from ${catalog}; ` +
        `valid examples: ${allow.slice(0, 5).join(", ")}`,
    );
  }
  return name;
}
