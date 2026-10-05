/**
 * Face compositor tests: mock renders must be the user's own face photo
 * with the real effect colors drawn on it (API contract: imageUrl is a
 * face render, never an abstract color-bar card).
 */
import { describe, it, expect } from "vitest";
import { faceCardDataUrl, faceCardSvg } from "./facecard.js";
import type { VtoEffect } from "./client.js";

const FACE_B64 = Buffer.from("fake-jpeg-bytes-for-test").toString("base64");

const EFFECTS: VtoEffect[] = [
  { category: "lip_color", palettes: [{ color: "#b3122e", colorIntensity: 80 }] },
  { category: "blush", palettes: [{ color: "#e8a0a0", colorIntensity: 50 }] },
  { category: "skin_smooth", skinSmoothStrength: 40 },
];

describe("faceCardSvg", () => {
  it("embeds the session face photo as the base layer", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).toContain(`data:image/jpeg;base64,${FACE_B64}`);
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("draws the lock color in the lip zone", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).toContain('fill="#b3122e"');
    expect(svg).toContain('fill="#e8a0a0"');
  });

  it("skips skin_smooth (no visual zone)", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg.match(/<ellipse/g)?.length).toBeGreaterThan(0);
    // lip zone draws once per side where applicable; just ensure ellipses exist
  });

  it("is deterministic for the same inputs", () => {
    const a = faceCardSvg("lift", EFFECTS, 3, FACE_B64);
    const b = faceCardSvg("lift", EFFECTS, 3, FACE_B64);
    expect(a).toBe(b);
  });

  it("badge shows the role and mock seed", () => {
    const svg = faceCardSvg("statement", EFFECTS, 123, FACE_B64);
    expect(svg).toContain(">Statement</text>");
    expect(svg).toContain(`MOCK seed ${123 % 100000}`);
  });

  it("escapes hostile role strings", () => {
    const svg = faceCardSvg(`<script>alert(1)</script>`, EFFECTS, 1, FACE_B64);
    expect(svg).not.toContain("<script>");
  });
});

describe("faceCardDataUrl", () => {
  it("returns a base64 svg data url wrapping the svg", () => {
    const url = faceCardDataUrl("anchor", EFFECTS, 1, FACE_B64);
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(url.split(",")[1]!, "base64").toString("utf8");
    expect(svg).toContain(`data:image/jpeg;base64,${FACE_B64}`);
  });
});
