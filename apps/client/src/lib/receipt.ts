/* Receipt sheet model: turns a look's recipe chips (POST /looks response)
 * into the rows behind the "What's on" chip. Server contract (domain/types):
 * chips[] is human-readable, lock first — chips[0] is the locked layer with
 * its on-face hex. No row is invented: malformed chips are dropped, an empty
 * list hides the chip entirely. */

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

function rowOf(chip: LookChip | undefined, locked: boolean): ReceiptRow | null {
  if (!chip || typeof chip.label !== "string" || chip.label.trim() === "") return null;
  if (typeof chip.hex !== "string" || !HEX_RE.test(chip.hex.trim())) return null;
  return {
    label: chip.label.trim(),
    detail: typeof chip.detail === "string" ? chip.detail.trim() : "",
    hex: chip.hex.trim(),
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
