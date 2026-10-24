import { strict as assert } from "node:assert";
import { test } from "node:test";
import { receiptChipLabel, receiptRows } from "./receipt.ts";
import type { LookChip } from "./types.ts";

const chip = (label: string, detail: string, hex: string): LookChip => ({ label, detail, hex });

test("receiptRows marks the first chip as the locked layer (server contract: lock first)", () => {
  const rows = receiptRows({
    chips: [
      chip("Lip", "Warm brick - locked", "#b3122e"),
      chip("Brow", "soft definition", "#5a4632"),
      chip("Cheek", "soft rose", "#d98d86"),
    ],
  });
  assert.equal(rows.length, 3);
  assert.equal(rows[0]!.locked, true);
  assert.equal(rows[0]!.label, "Lip");
  assert.equal(rows[0]!.hex, "#b3122e");
  assert.equal(rows[1]!.locked, false);
  assert.equal(rows[2]!.locked, false);
});

test("receiptRows keeps a single-layer anchor look intact", () => {
  const rows = receiptRows({ chips: [chip("Lip", "Warm brick - locked", "#b3122e")] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.locked, true);
});

test("receiptRows drops malformed chips instead of inventing data", () => {
  const rows = receiptRows({
    chips: [
      chip("Lip", "locked", "#b3122e"),
      { label: "   ", detail: "blank label", hex: "#ffffff" },
      { label: "Eye", detail: "bad hex", hex: "fff" },
      { label: "Contour", detail: "no hex", hex: "" },
    ],
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.label, "Lip");
});

test("receiptRows tolerates missing looks and non-array chips", () => {
  assert.deepEqual(receiptRows(null), []);
  assert.deepEqual(receiptRows(undefined), []);
  assert.deepEqual(receiptRows({ chips: undefined as unknown as LookChip[] }), []);
});

test("receiptChipLabel is singular-aware", () => {
  assert.equal(receiptChipLabel(receiptRows({ chips: [chip("Lip", "locked", "#b3122e")] })), "What's on \u00b7 1 layer");
  assert.equal(
    receiptChipLabel(
      receiptRows({ chips: [chip("Lip", "locked", "#b3122e"), chip("Brow", "soft", "#5a4632")] }),
    ),
    "What's on \u00b7 2 layers",
  );
});

test("receiptChipLabel returns null when there is nothing real to show", () => {
  assert.equal(receiptChipLabel([]), null);
  assert.equal(receiptChipLabel(receiptRows({ chips: [] })), null);
});
