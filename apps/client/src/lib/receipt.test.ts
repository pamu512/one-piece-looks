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
  assert.equal(rows[0]!.detail, "Warm brick");
  assert.equal(rows[0]!.hex, "#b3122e");
  assert.equal(rows[1]!.locked, false);
  assert.equal(rows[2]!.locked, false);
});

test("receiptRows keeps a single-layer anchor look intact", () => {
  const rows = receiptRows({ chips: [chip("Lip", "Warm brick - locked", "#b3122e")] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.locked, true);
  assert.equal(rows[0]!.detail, "Warm brick");
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
  assert.equal(rows[0]!.detail, "");
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

test("locked row drops a trailing locked word and leaves later rows alone", () => {
  const rows = receiptRows({
    chips: [
      chip("Lip", "berry - locked", "#b3122e"),
      chip("Note", "berry - locked", "#112233"),
    ],
  });
  assert.equal(rows[0]!.label, "Lip");
  assert.equal(rows[0]!.detail, "berry");
  assert.equal(rows[0]!.locked, true);
  assert.equal(rows[1]!.label, "Note");
  assert.equal(rows[1]!.detail, "berry - locked");
  assert.equal(rows[1]!.locked, false);
});

test("locked row strips the word from the label and keeps a hyphen in the shade", () => {
  const rows = receiptRows({
    chips: [chip("Lip - locked", "warm brick - rose - locked", "#b3122e")],
  });
  assert.equal(rows[0]!.label, "Lip");
  assert.equal(rows[0]!.detail, "warm brick - rose");
});

test("locked row removes an embedded locked word and keeps unlocked and blocked", () => {
  const rows = receiptRows({
    chips: [chip("Cheek", "soft locked rose, unlocked shimmer, blocked", "#b3122e")],
  });
  assert.equal(rows[0]!.detail, "soft rose, unlocked shimmer, blocked");
});

test("a chip that is only the word locked does not repeat it beside the tag", () => {
  const rows = receiptRows({ chips: [chip("locked", "LOCKED", "#aabbcc")] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.locked, true);
  assert.equal(rows[0]!.label, "");
  assert.equal(rows[0]!.detail, "");
  assert.equal(rows[0]!.hex, "#aabbcc");
});

test("locked row accepts the separators the chip copy actually uses", () => {
  const cases: Array<[string, string]> = [
    ["berry - locked", "berry"],
    ["red - locked", "red"],
    ["berry \u2013 locked", "berry"],
    ["berry \u2014 locked", "berry"],
    ["berry\u00b7locked", "berry"],
    ["berry: locked", "berry"],
    ["BeRrY - LoCkEd", "BeRrY"],
    ["locked berry", "berry"],
    ["soft  locked  rose", "soft rose"],
    ["berry - locked.", "berry"],
    ["berry (locked)", "berry"],
    ["(locked)", ""],
    ["locked.", ""],
    ["berry / locked", "berry"],
  ];
  for (const [detail, expect] of cases) {
    const rows = receiptRows({ chips: [chip("Lip", detail, "#b3122e")] });
    assert.equal(rows[0]!.detail, expect, detail);
    assert.equal(/\blocked\b/i.test(`${rows[0]!.label} ${rows[0]!.detail}`), false, detail);
  }
});

test("locked row keeps words that only contain those letters", () => {
  const rows = receiptRows({
    chips: [chip("Lip", "clocked lock, unlocked shimmer, blocked", "#B3122E")],
  });
  assert.equal(rows[0]!.detail, "clocked lock, unlocked shimmer, blocked");
  assert.equal(rows[0]!.hex, "#b3122e");
});

test("a later row keeps its own locked wording and a bad hex is dropped", () => {
  const rows = receiptRows({
    chips: [
      chip("Lip", "berry (locked).", "#b3122e"),
      chip("Note", "berry - locked", "#112233"),
      chip("Eye", "skip", "not-a-hex"),
    ],
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.detail, "berry");
  assert.equal(rows[1]!.detail, "berry - locked");
});
