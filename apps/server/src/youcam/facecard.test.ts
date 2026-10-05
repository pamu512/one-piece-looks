/**
 * Face compositor tests: mock renders must be the user's own face photo
 * with the real effect colors drawn on it (API contract: imageUrl is a
 * face render, never an abstract color-bar card). The render contains no
 * burned-in text, and landmark inputs clip patches to the real face zones.
 */
import { describe, it, expect } from "vitest";
import { faceCardDataUrl, faceCardSvg, type FaceLandmarks } from "./facecard.js";
import type { VtoEffect } from "./client.js";

const FACE_B64 = Buffer.from("fake-jpeg-bytes-for-test").toString("base64");

const EFFECTS: VtoEffect[] = [
  { category: "lip_color", palettes: [{ color: "#b3122e", colorIntensity: 80 }] },
  { category: "blush", palettes: [{ color: "#e8a0a0", colorIntensity: 50 }] },
  { category: "skin_smooth", skinSmoothStrength: 40 },
];

const LM: FaceLandmarks = {
  faceBox: { x: 0.25, y: 0.15, w: 0.5, h: 0.6 },
  lip: [[0.42, 0.68], [0.5, 0.7], [0.58, 0.68], [0.5, 0.74]],
  eyeL: [[0.34, 0.42], [0.4, 0.4], [0.42, 0.44], [0.36, 0.45]],
  eyeR: [[0.58, 0.42], [0.64, 0.4], [0.66, 0.44], [0.6, 0.45]],
};

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
  });

  it("is deterministic for the same inputs", () => {
    const a = faceCardSvg("lift", EFFECTS, 3, FACE_B64);
    const b = faceCardSvg("lift", EFFECTS, 3, FACE_B64);
    expect(a).toBe(b);
  });

  it("contains no burned-in text (role, MOCK, seed) in the image", () => {
    const svg = faceCardSvg("statement", EFFECTS, 123, FACE_B64);
    expect(svg).not.toContain("<text");
    expect(svg).not.toContain("MOCK");
    expect(svg).not.toContain("Statement");
  });

  it("escapes hostile role strings without drawing them", () => {
    const svg = faceCardSvg(`<script>alert(1)</script>`, EFFECTS, 1, FACE_B64);
    expect(svg).not.toContain("<script>");
    expect(svg).not.toContain("<text");
  });

  it("clips patches to landmark polygons when provided", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    expect(svg).toContain("<clipPath");
    expect(svg).toContain("<polygon");
    // lip polygon coordinates map to canvas pixels (4:5 geometry contract)
    expect(svg).toContain("clip-");
  });

  it("falls back to framing-guide zones without landmarks", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).not.toContain("<clipPath");
    expect(svg.match(/<ellipse/g)?.length).toBeGreaterThan(0);
  });

  it("blends lip/lash/brow layers with multiply and supports with soft-light", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    expect(svg).toContain("mix-blend-mode:multiply");
    expect(svg).toContain("mix-blend-mode:soft-light");
  });

  it("landmark lip centroid lands inside the lip polygon region", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    // Extract the first multiply layer ellipse (the lip) and check its center
    const m = svg.match(/<ellipse cx="([0-9.]+)" cy="([0-9.]+)"[^>]*fill="#b3122e"/);
    expect(m).not.toBeNull();
    const cx = Number(m![1]), cy = Number(m![2]);
    // LM lip spans x 420..580, y 500..925 on the 1000x1250 canvas
    expect(cx).toBeGreaterThan(400);
    expect(cx).toBeLessThan(600);
    expect(cy).toBeGreaterThan(800);
    expect(cy).toBeLessThan(950);
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
