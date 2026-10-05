import { describe, it, expect } from "vitest";
import { buildLooks, type BuildInput } from "./builder.js";

const base: BuildInput = {
  lock: { category: "lip", onFaceHex: "#b3122e", productHex: "#c01830", unverified: false },
  skinType: "Normal",
  tone: { source: "api", skinColor: "#c28e6b" },
  mood: "Boss",
  event: "Office",
  seed: 42,
};

describe("builder: edge cases", () => {
  it("handles an extremely dark lock hex (nearly black)", () => {
    const looks = buildLooks({ ...base, lock: { ...base.lock, onFaceHex: "#050505" } });
    expect(looks).toHaveLength(3);
    for (const look of looks) {
      for (const e of look.effects) {
        if (e.palettes) {
          const pal = (e.palettes as any[])[0];
          if (pal?.color) expect(pal.color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("handles an extremely light lock hex (nearly white)", () => {
    const looks = buildLooks({ ...base, lock: { ...base.lock, onFaceHex: "#fefefe" } });
    expect(looks).toHaveLength(3);
    for (const look of looks) {
      for (const e of look.effects) {
        if (e.palettes) {
          const pal = (e.palettes as any[])[0];
          if (pal?.color) expect(pal.color).toMatch(/^#[0-9a-f]{6}$/);
        }
      }
    }
  });

  it("consistent across different categories", () => {
    const cats: any[] = ["lip", "cheek", "eye", "brow", "liner"];
    for (const cat of cats) {
      const looks = buildLooks({ ...base, lock: { ...base.lock, category: cat } });
      expect(looks).toHaveLength(3);
      expect(looks[0].chips[0].label).toBe(cat.charAt(0).toUpperCase() + cat.slice(1));
    }
  });
});
