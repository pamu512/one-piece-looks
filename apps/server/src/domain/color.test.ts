import { describe, it, expect } from "vitest";
import {
  classifyFamily,
  colorDistance,
  describeShift,
  isHex,
  mix,
  nearestShade,
  rgbToHex,
  hexToRgb,
  shiftHue,
} from "./color.js";

describe("hex parsing", () => {
  it("round-trips", () => {
    expect(rgbToHex(hexToRgb("#A34DE1"))).toBe("#a34de1");
  });
  it("rejects malformed", () => {
    expect(isHex("#12345")).toBe(false);
    expect(isHex("#12345G")).toBe(false);
    expect(isHex("123456")).toBe(false);
  });
});

describe("classifyFamily", () => {
  it("classic red lipstick", () => {
    expect(classifyFamily("#b3122e")).toBe("red");
  });
  it("nude-ish pink", () => {
    expect(classifyFamily("#d9908a")).toBe("pink");
  });
  it("deep berry", () => {
    expect(classifyFamily("#7a1838")).toBe("berry");
  });
  it("peach", () => {
    expect(classifyFamily("#f2b48a")).toBe("peach");
  });
  it("brown/neutral territory", () => {
    expect(["brown", "neutral", "mauve"]).toContain(classifyFamily("#8a6a5c"));
  });
});

describe("shift description (spec copy)", () => {
  it("near-identical -> true to the pan", () => {
    expect(describeShift("#b3122e", "#b61a30")).toMatch(/True to the pan on you/);
  });
  it("darker on face -> deeper", () => {
    expect(describeShift("#d4486a", "#8e2440")).toMatch(/deeper/);
  });
  it("lighter on face -> brighter", () => {
    expect(describeShift("#8e2440", "#d4486a")).toMatch(/brighter/);
  });
});

describe("distance + nearest shade", () => {
  it("black vs white is far, same color is zero", () => {
    expect(colorDistance("#000000", "#ffffff")).toBeGreaterThan(700);
    expect(colorDistance("#123456", "#123456")).toBe(0);
  });
  it("nearest shade picks the closest", () => {
    const shades = [
      { name: "red", hex: "#ff0000" },
      { name: "green", hex: "#00ff00" },
      { name: "blue", hex: "#0000ff" },
    ];
    expect(nearestShade("#0101fe", shades).name).toBe("blue");
    expect(nearestShade("#fe0f0f", shades).name).toBe("red");
  });
});

describe("mix + shiftHue", () => {
  it("mix endpoints", () => {
    expect(mix("#000000", "#ffffff", 0)).toBe("#000000");
    expect(mix("#000000", "#ffffff", 1)).toBe("#ffffff");
    expect(mix("#000000", "#ffffff", 0.5)).toBe("#808080");
  });
  it("shiftHue keeps lightness for grays", () => {
    expect(shiftHue("#808080", 120)).toBe("#808080");
  });
  it("shiftHue rotates primaries", () => {
    expect(shiftHue("#ff0000", 120)).toBe("#00ff00");
    expect(shiftHue("#ff0000", 240)).toBe("#0000ff");
  });
});
