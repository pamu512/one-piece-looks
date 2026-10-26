/* Receipt sheet model: turns a look's recipe chips (POST /looks response)
 * into the rows behind the "What's on" chip. Server contract (domain/types):
 * chips[] is human-readable, lock first. chips[0] is the locked layer with
 * its on-face hex. No row is invented: malformed chips are dropped, an empty
 * list hides the chip entirely.
 *
 * The server also marks the locked layer in its own chip text (builder.ts
 * details like "berry - locked"). The sheet stamps its own Locked tag on
 * that row, so locked-row text drops the redundant word. The tag is the
 * only "Locked". Server chips stay untouched. */

import type { Look, LookChip } from "./types";

/** One row of the receipt sheet: swatch + name + shade note. */
export interface ReceiptRow {
  label: string;
  detail: string;
  hex: string;
  /** True on the locked layer (chips[0] per contract). */
  locked: boolean;
}

const HEX_RE = /^#[0-9a-f]{6}$/;

/* Punctuation that only joined the word "locked". A hyphen inside the
 * remaining shade stays, because it is not sitting on the removed word. */
const ATTACHED_LEAD = /^[\s\-\u2013\u2014\u00b7,;:.!?()[\]{}"'/]+/;
const ATTACHED_TRAIL = /[\s\-\u2013\u2014\u00b7,;:.!?()[\]{}"'/]+$/;

/**
 * Drop the whole word "locked" (any case). "unlocked", "blocked", "lock",
 * and "clocked" stay: the boundary is the word, not the letters.
 * "warm brick - rose - locked" becomes "warm brick - rose".
 * "berry (locked)." becomes "berry".
 */
function stripLockedWord(text: string): string {
  const parts = text.split(/\blocked\b/i);
  if (parts.length === 1) return text.trim();
  const kept: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    let part = parts[i] ?? "";
    if (i > 0) part = part.replace(ATTACHED_LEAD, "");
    if (i < parts.length - 1) part = part.replace(ATTACHED_TRAIL, "");
    if (part !== "") kept.push(part);
  }
  return kept.join(" ").replace(/\s{2,}/g, " ").trim();
}

function rowOf(chip: LookChip | undefined, locked: boolean): ReceiptRow | null {
  if (!chip || typeof chip.label !== "string" || chip.label.trim() === "") return null;
  if (typeof chip.hex !== "string") return null;
  const label = chip.label.trim();
  const detail = typeof chip.detail === "string" ? chip.detail.trim() : "";
  const hex = chip.hex.trim().toLowerCase();
  if (!HEX_RE.test(hex)) return null;
  if (!locked) return { label, detail, hex, locked };
  // Locked row: the tag is the only "Locked". An empty label is kept empty
  // so a chip whose name was just that word does not repeat it.
  return {
    label: stripLockedWord(label),
    detail: stripLockedWord(detail),
    hex,
    locked,
  };
}

/** Rows for one look's receipt sheet; empty array when there is nothing real to show. */
export function receiptRows(look: Pick<Look, "chips"> | null | undefined): ReceiptRow[] {
  if (!look || !Array.isArray(look.chips)) return [];
  const rows: ReceiptRow[] = [];
  for (let i = 0; i < look.chips.length; i++) {
    const row = rowOf(look.chips[i], i === 0);
    if (row) rows.push(row);
  }
  return rows;
}

/** Label for the opening chip: "What's on · N layers" (singular-aware).
 *  Null when there are no rows — the chip must not render empty. */
export function receiptChipLabel(rows: ReceiptRow[]): string | null {
  if (rows.length === 0) return null;
  return `What's on \u00b7 ${rows.length} layer${rows.length === 1 ? "" : "s"}`;
}
