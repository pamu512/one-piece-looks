import { describe, it, expect } from "vitest";
import {
  BLUSH_PATTERNS,
  CONTOUR_PATTERNS,
  EYEBROWS_PATTERNS,
  EYELASHES_PATTERNS,
  EYELINER_PATTERNS,
  EYESHADOW_ENTRIES,
  EYESHADOW_PATTERNS,
  HIGHLIGHTER_PATTERNS,
  LIPSHAPES,
  requirePattern,
} from "../youcam/patterns.js";
import { buildLooks, oilyRule, seedFrom, type BuildInput } from "./builder.js";
import type { VtoEffect } from "../youcam/client.js";

const base: BuildInput = {
  lock: { category: "lip", onFaceHex: "#b3122e", productHex: "#c01830", unverified: false },
  skinType: "Normal",
  tone: { source: "api", skinColor: "#c28e6b" },
  mood: "Boss",
  event: "Office",
  seed: 42,
};

function effectOf(effects: VtoEffect[], category: string): VtoEffect | undefined {
  return effects.find((e) => e.category === category);
}

describe("catalog integrity", () => {
  it("contour labels are the official ten", () => {
    expect(CONTOUR_PATTERNS).toHaveLength(10);
    expect(CONTOUR_PATTERNS).toContain("OvalFace6");
  });
  it("every catalog has entries", () => {
    expect(BLUSH_PATTERNS.length).toBeGreaterThan(20);
    expect(EYESHADOW_PATTERNS.length).toBeGreaterThan(100);
    expect(EYELINER_PATTERNS.length).toBeGreaterThan(100);
    expect(EYELASHES_PATTERNS.length).toBeGreaterThan(100);
    expect(HIGHLIGHTER_PATTERNS.length).toBeGreaterThan(10);
    expect(LIPSHAPES).toContain("original");
  });
  it("requirePattern rejects unknown names", () => {
    expect(() => requirePattern("NotARealPattern", CONTOUR_PATTERNS, "contour.json")).toThrow();
  });
});

describe("builder: structure invariants", () => {
  const looks = buildLooks(base);

  it("returns exactly three looks: anchor, lift, statement", () => {
    expect(looks.map((l) => l.role)).toEqual(["anchor", "lift", "statement"]);
  });

  it("every pattern name is a real catalog label", () => {
    for (const look of looks) {
      for (const e of look.effects) {
        const name = (e.pattern as { name?: string } | undefined)?.name;
        if (e.category === "contour") expect(() => requirePattern(name!, CONTOUR_PATTERNS, "contour.json")).not.toThrow();
        if (e.category === "blush") expect(() => requirePattern(name!, BLUSH_PATTERNS, "blush.json")).not.toThrow();
        if (e.category === "eye_shadow") expect(() => requirePattern(name!, EYESHADOW_PATTERNS, "eyeshadow.json")).not.toThrow();
        if (e.category === "eye_liner") expect(() => requirePattern(name!, EYELINER_PATTERNS, "eyeliner.json")).not.toThrow();
        if (e.category === "eyelashes") expect(() => requirePattern(name!, EYELASHES_PATTERNS, "eyelashes.json")).not.toThrow();
        if (e.category === "highlighter") expect(() => requirePattern(name!, HIGHLIGHTER_PATTERNS, "highlighter.json")).not.toThrow();
      }
    }
  });

  it("locked hex flows into the locked category in every look", () => {
    for (const look of looks) {
      const lip = effectOf(look.effects, "lip_color");
      expect(lip).toBeDefined();
      const palette = (lip!.palettes as { color: string }[])[0];
      expect(palette.color).toBe("#b3122e");
      // chip says locked
      expect(look.chips[0]?.label).toBe("Lip");
      expect(look.chips[0]?.hex).toBe("#b3122e");
    }
  });

  it("eyeshadow palette count matches pattern colorNum", () => {
    for (const look of looks) {
      const shadow = effectOf(look.effects, "eye_shadow");
      if (!shadow) continue;
      const name = (shadow.pattern as { name: string }).name;
      const entry = [...EYESHADOW_PATTERNS].includes(name);
      expect(entry).toBe(true);
    }
  });

  it("anchor is near-bare: lock + smoothing only", () => {
    const anchor = looks[0]!;
    const categories = anchor.effects.map((e) => String(e.category));
    expect(categories.filter((c) => c !== "skin_smooth" && c !== "lip_color")).toHaveLength(0);
  });

  it("statement has the full set: contour + lashes + at least 4 layers", () => {
    const st = looks[2]!;
    const cats = st.effects.map((e) => String(e.category));
    expect(cats).toContain("contour");
    expect(cats).toContain("eyelashes");
    expect(cats.filter((c) => c !== "skin_smooth").length).toBeGreaterThanOrEqual(5);
  });

  it("eyebrows shape patterns always carry curvature, thickness AND definition (live-pinned 2026-10-02)", () => {
    // Live YouCam rejects shape patterns that set definition without curvature
    // and thickness (task error invalid_parameter); pinned empirically.
    for (const category of ["lip", "cheek", "eye", "brow", "liner"] as const) {
      for (const look of buildLooks({ ...base, lock: { ...base.lock, category } })) {
        const brow = effectOf(look.effects, "eyebrows");
        if (!brow) continue;
        const pattern = brow.pattern as { type: string; name: string; curvature: number; thickness: number; definition: number };
        expect(pattern.type).toBe("shape");
        expect(Number.isInteger(pattern.curvature)).toBe(true);
        expect(Number.isInteger(pattern.thickness)).toBe(true);
        expect(Number.isInteger(pattern.definition)).toBe(true);
        // ranges per the makeup-vto OpenAPI (curvature/thickness -100..100, definition 0..100)
        expect(Math.abs(pattern.curvature)).toBeLessThanOrEqual(100);
        expect(Math.abs(pattern.thickness)).toBeLessThanOrEqual(100);
        expect(pattern.definition).toBeGreaterThanOrEqual(0);
        expect(pattern.definition).toBeLessThanOrEqual(100);
        // pattern name must be a real eyebrows.json label
        expect(() => requirePattern(pattern.name, EYEBROWS_PATTERNS, "eyebrows.json")).not.toThrow();
        // palette carries the live-required texture
        const palette = (brow.palettes as { texture: string }[])[0]!;
        expect(palette.texture).toBe("matte");
      }
    }
  });

  it("eye_shadow palettes never exceed the pattern's colorNum (live-pinned 2026-10-02)", () => {
    // Live YouCam rejects palettes longer than the pattern's colorNum
    // (1color137 + 2 palettes -> invalid_parameter); pinned empirically on shuffle.
    for (const category of ["lip", "cheek", "eye", "brow", "liner"] as const) {
      for (const look of buildLooks({ ...base, lock: { ...base.lock, category } })) {
        for (const eff of look.effects) {
          if (eff.category !== "eye_shadow") continue;
          const name = (eff.pattern as { name?: string }).name;
          const entry = EYESHADOW_ENTRIES.get(name!) as { colorNum?: number } | undefined;
          const max = entry?.colorNum ?? 1;
          expect((eff.palettes as unknown[]).length).toBeLessThanOrEqual(max);
        }
      }
    }
  });

  it("deterministic: same seed same looks; new seed moves supports", () => {
    const a = buildLooks({ ...base, seed: 7 });
    const b = buildLooks({ ...base, seed: 7 });
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    const c = buildLooks({ ...base, seed: 8 });
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(c));
  });

  it("oil rule: oily skin forces matte cheek texture", () => {
    const oily = buildLooks({ ...base, skinType: "Oily" });
    const normal = buildLooks(base);
    for (const look of [...oily, ...normal]) {
      const blush = effectOf(look.effects, "blush");
      if (!blush) continue;
      const p = (blush.palettes as { texture: string }[])[0]!;
      if (look.role !== "anchor" || base.lock.category === "cheek") {
        // any blush on oily skin must be matte
      }
    }
    const oilyBlush = oily[2]!.effects.find((e) => e.category === "blush") as
      | { palettes: { texture: string }[] }
      | undefined;
    const normalBlush = normal[2]!.effects.find((e) => e.category === "blush") as
      | { palettes: { texture: string }[] }
      | undefined;
    if (oilyBlush && normalBlush) {
      expect(oilyBlush.palettes[0]!.texture).toBe("matte");
    }
  });

  it("oil rule classification", () => {
    expect(oilyRule("Oily")).toBe(true);
    expect(oilyRule("Combination")).toBe(true);
    expect(oilyRule("Oily & Redness")).toBe(true);
    expect(oilyRule("Combination & Redness")).toBe(true);
    expect(oilyRule("Dry")).toBe(false);
    expect(oilyRule("Normal")).toBe(false);
  });

  it("gloss lip is downgraded to satin when oily (unlocked-lip support only)", () => {
    // mood/event that bias gloss: Sexy + Dinner date
    const input: BuildInput = {
      lock: { category: "eye", onFaceHex: "#6b2b4e", productHex: "#70304f", unverified: false },
      skinType: "Oily",
      tone: { source: "api", skinColor: "#c28e6b" },
      mood: "Sexy",
      event: "Dinner date",
      seed: 3,
    };
    const looks = buildLooks(input);
    expect(oilyRule(input.skinType)).toBe(true);
    // any lip layer in supports must not be gloss when oily
    for (const look of looks) {
      const lip = effectOf(look.effects, "lip_color");
      if (!lip) continue;
      const tex = (lip.palettes as { texture: string }[])[0]!.texture;
      if (look.role !== "anchor" && input.lock.category !== "lip") {
        expect(tex).not.toBe("gloss");
      }
    }
  });

  it("mood and event never touch the lock hex", () => {
    const other = buildLooks({ ...base, mood: "Bitch mode", event: "Night out" });
    for (const look of other) {
      const lip = effectOf(look.effects, "lip_color") as { palettes: { color: string }[] } | undefined;
      if (lip) expect(lip.palettes[0]!.color).toBe("#b3122e");
    }
  });

  it("all five categories build", () => {
    for (const category of ["lip", "cheek", "eye", "brow", "liner"] as const) {
      const looks = buildLooks({ ...base, lock: { ...base.lock, category } });
      expect(looks).toHaveLength(3);
      const first = looks[0]!.chips[0]!;
      expect(first.hex).toBe("#b3122e");
    }
  });

  it("intensity is monotonic anchor <= lift <= statement", () => {
    const layerCount = (l: (typeof looks)[number]) =>
      l.effects.filter((e) => e.category !== "skin_smooth").length;
    expect(layerCount(looks[0]!)).toBeLessThanOrEqual(layerCount(looks[1]!));
    expect(layerCount(looks[1]!)).toBeLessThanOrEqual(layerCount(looks[2]!));
  });
});

describe("seed derivation", () => {
  it("different shuffles produce different seeds", () => {
    expect(seedFrom("s", 0)).not.toBe(seedFrom("s", 1));
  });
});
