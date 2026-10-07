/**
 * Face compositor tests: the mock render is the session photo plus soft
 * LAB paint. No eye ellipses. Lip hex stays put while role scales alpha.
 */
import { describe, it, expect } from "vitest";
import {
  applyLipComposite,
  applySoftLab,
  faceCardDataUrl,
  faceCardSvg,
  featherSigma,
  interEyePx,
  labLerp,
  labMatrixText,
  labToSrgb,
  lipMaskAlpha,
  lipVermillionEdge,
  LIP_COLOR_KEEP,
  LIP_DEPTH,
  LIP_MASK_GAMMA,
  oddFeatherKernel,
  srgbToLab,
  zoneAlpha,
  zoneLightness,
  type FaceLandmarks,
} from "./facecard.js";
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

function attr(tag: string, name: string): string | null {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1]! : null;
}

function zonePaths(svg: string, zone: string): { cx: number; cy: number; rx: number; ry: number; grad: string | null; alpha: number; fill: string | null; lightness: number }[] {
  const tags = svg.match(/<path\b[^>]*>/g) ?? [];
  const out: { cx: number; cy: number; rx: number; ry: number; grad: string | null; alpha: number; fill: string | null; lightness: number }[] = [];
  for (const tag of tags) {
    if (attr(tag, "data-zone") !== zone) continue;
    out.push({
      cx: Number(attr(tag, "data-cx")),
      cy: Number(attr(tag, "data-cy")),
      rx: Number(attr(tag, "data-rx")),
      ry: Number(attr(tag, "data-ry")),
      grad: attr(tag, "data-grad"),
      alpha: Number(attr(tag, "data-alpha")),
      fill: attr(tag, "fill"),
      lightness: Number(attr(tag, "data-lightness") ?? "0"),
    });
  }
  return out;
}

function blushPair(svg: string): { cx: number; cy: number; rx: number; ry: number; grad: string | null }[] {
  const pair = zonePaths(svg, "blush");
  expect(pair).toHaveLength(2);
  return pair[0]!.cx <= pair[1]!.cx ? pair : [pair[1]!, pair[0]!];
}

describe("faceCardSvg", () => {
  it("embeds the session face photo as the base layer", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).toContain(`data:image/jpeg;base64,${FACE_B64}`);
    expect(svg.startsWith("<svg")).toBe(true);
  });

  it("draws the lock color in the lip zone", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).toContain('flood-color="#b3122e"');
    expect(svg).toContain('stop-color="#e8a0a0"');
  });

  it("skips skin_smooth as its own paint zone", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).not.toContain('data-zone="skin_smooth"');
    expect(zonePaths(svg, "blush").length).toBeGreaterThan(0);
    expect(svg).toContain('mode="multiply"');
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

  it("paints the lip as an evenodd ring and never an ellipse", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain("<ellipse");
    expect(svg).not.toContain("<clipPath");
    const lip = svg.match(/data-zone="lip_color"[^>]*d="([^"]+)"/);
    expect(lip).not.toBeNull();
    const subs = lip![1]!.split(" Z").filter((s) => s.includes("M"));
    expect(subs.length).toBeGreaterThanOrEqual(2);
  });

  it("falls back to shelf paths without landmarks", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("<ellipse");
    expect(svg).toContain("<path");
    expect(svg).toContain('data-hole="fissure"');
  });

  it("grades lips with the sRGB color/soft-light stage and keeps the veil multiply", () => {
    const svg = faceCardSvg("statement", EFFECTS, 7, FACE_B64, LM);
    expect(svg).toContain(labMatrixText().slice(0, 24));
    expect(svg).toContain('mode="multiply"');
    expect(svg).toContain('mode="color"');
    expect(svg).toContain('mode="soft-light"');
    expect(svg).toContain(`k2="${LIP_COLOR_KEEP.toFixed(4)}" k3="${LIP_DEPTH.toFixed(4)}"`);
    expect(svg).toContain(`exponent="${LIP_MASK_GAMMA.toFixed(3)}"`);
    expect(svg).not.toContain('k2="0.45"');
    expect(svg).toContain('flood-color="#b3122e"');
    expect(svg).toContain('stop-color="#e8a0a0"');
    // the lip mask itself is white geometry (blend reads alpha, not color)
    const lipPath = svg.match(/data-zone="lip_color"[^>]*>/)![0]!;
    expect(lipPath).toContain('fill="#ffffff"');
    expect(lipPath).toContain('fill-rule="evenodd"');
  });

  it("paints the lip fill on the landmark polygon, not a jittered ellipse", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    const again = faceCardSvg("anchor", EFFECTS, 2, FACE_B64, LM);
    const m = svg.match(/data-zone="lip_color"[^>]*d="([^"]+)"/);
    expect(m).not.toBeNull();
    expect(again).toContain(m![1]!);
    // landmark ring, not a shrunk hull: 0.42, 0.68 lands on the canvas
    expect(m![1]).toContain("420.0,850.0");
    const outer = m![1]!.split(" Z")[0]!;
    const nums = outer.match(/-?\d+\.?\d*/g)!.map(Number);
    const xs = nums.filter((_, i) => i % 2 === 0);
    const ys = nums.filter((_, i) => i % 2 === 1);
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    expect(cx).toBeGreaterThan(400);
    expect(cx).toBeLessThan(600);
    expect(cy).toBeGreaterThan(800);
    expect(cy).toBeLessThan(950);
  });

  it("clips the lip ramp to the vermillion instead of an outward 0.06 skirt", () => {
    const svg = faceCardSvg("statement", EFFECTS, 7, FACE_B64, LM);
    const support = oddFeatherKernel(interEyePx(LM), 0.06);
    const morph = svg.match(/<feMorphology in="lpsh" operator="erode" radius="(\d+)" result="lper"\/>/);
    const blur = svg.match(/<feGaussianBlur in="lper" stdDeviation="([0-9.]+)" result="lpbl"\/>/);
    expect(morph).not.toBeNull();
    expect(blur).not.toBeNull();
    const radius = Number(morph![1]);
    const sigma = Number(blur![1]);
    expect(radius).toBeGreaterThanOrEqual(1);
    expect(radius).toBeLessThanOrEqual(4);
    expect(radius).toBeLessThan(support);
    expect(sigma).toBeLessThan(featherSigma(support));
    expect(svg).toContain('<feComposite in="lpbl" in2="lpsh" operator="in" result="lpcl"/>');
    expect(svg).not.toContain('operator="dilate"');
    expect(svg).toContain('mode="color"');
    expect(svg).toContain('mode="soft-light"');
    const lip = zonePaths(svg, "lip_color")[0];
    expect(lip).toBeTruthy();
    expect(svg).toContain(`data-kernel="${radius}"`);
    const edge = lipVermillionEdge(interEyePx(LM), lip!.ry);
    expect(radius).toBe(edge.radius);
    expect(sigma).toBeCloseTo(edge.sigma, 3);
    expect(lipVermillionEdge(Number.NaN, Number.NaN).radius).toBeGreaterThanOrEqual(1);
  });

  it("feathers blush toward the cheekbone and keeps shadow on a thin lid shelf", () => {
    const svg = faceCardSvg("lift", [
      ...EFFECTS,
      { category: "eye_shadow", palettes: [{ color: "#8a4038", colorIntensity: 50 }] },
    ], 1, FACE_B64, LM);
    expect(svg).toMatch(/<radialGradient id="g-blush[^"]*" cx="0.5" cy="0.38"/);
    expect(svg).toContain('offset="1" stop-color="#e8a0a0" stop-opacity="0"');
    expect(svg).not.toContain("<ellipse");
    const lids = zonePaths(svg, "eye_shadow");
    expect(lids).toHaveLength(2);
    const eyeCy = ((0.42 + 0.4 + 0.44 + 0.45) / 4) * 1250;
    const eyeTop = 0.4 * 1250;
    for (const lid of lids) {
      expect(lid.rx).toBeGreaterThan(lid.ry * 2);
      expect(lid.cy).toBeLessThan(eyeCy);
      expect(lid.cy + lid.ry).toBeGreaterThan(eyeTop);
      expect(lid.cy - lid.ry).toBeGreaterThan(eyeTop - 40);
      expect(lid.lightness).toBeLessThanOrEqual(0.1);
    }
  });

  it("uses one lip-mass path for every role", () => {
    const path = (role: string) => {
      const svg = faceCardSvg(role, EFFECTS, 7, FACE_B64, LM);
      const m = svg.match(/data-zone="lip_color"[^>]*d="([^"]+)"/);
      expect(m).not.toBeNull();
      return m![1];
    };
    const statement = path("statement");
    expect(path("anchor")).toBe(statement);
    expect(path("lift")).toBe(statement);
  });

  it("keeps the lock hex and scales lip alpha by role", () => {
    const alpha = (role: string) => zonePaths(faceCardSvg(role, EFFECTS, 7, FACE_B64), "lip_color")[0]!.alpha;
    const anchor = alpha("anchor");
    const lift = alpha("lift");
    const statement = alpha("statement");
    expect(anchor).toBeGreaterThan(0.2);
    expect(lift).toBeGreaterThan(anchor);
    expect(statement).toBeGreaterThan(lift);
    for (const role of ["anchor", "lift", "statement"]) {
      expect(faceCardSvg(role, EFFECTS, 7, FACE_B64)).toContain('flood-color="#b3122e"');
    }
  });

  it("paints a higher colorIntensity stronger than a soft mood", () => {
    const blush = (ci: number) => zonePaths(faceCardSvg("statement", [
      { category: "blush", palettes: [{ color: "#e8a0a0", colorIntensity: ci }] },
    ], 1, FACE_B64), "blush")[0]!.alpha;
    expect(blush(70)).toBeGreaterThan(blush(40) + 0.05);
  });

  it("statement supporting layers render stronger than lift for the same effects", () => {
    const lift = faceCardSvg("lift", EFFECTS, 7, FACE_B64);
    const statement = faceCardSvg("statement", EFFECTS, 7, FACE_B64);
    expect(lift).not.toBe(statement);
    expect(zonePaths(statement, "blush")[0]!.alpha).toBeGreaterThan(zonePaths(lift, "blush")[0]!.alpha);
  });

  it("feathers supporting layers to a zero rim and shares one blush gradient", () => {
    const svg = faceCardSvg("statement", EFFECTS, 7, FACE_B64, LM);
    expect(svg).toContain('offset="1" stop-color="#e8a0a0" stop-opacity="0"');
    const grads = svg.match(/id="g-blush/g) ?? [];
    expect(grads).toHaveLength(1);
    const pair = blushPair(svg);
    expect(pair[0]!.grad).toBe(pair[1]!.grad);
  });

  it("mirrors unequal cheek landmarks about the face axis", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: 0.2, y: 0.12, w: 0.55, h: 0.7 },
      eyeL: [[0.28, 0.34], [0.38, 0.32], [0.40, 0.38], [0.30, 0.39]],
      eyeR: [[0.62, 0.36], [0.74, 0.33], [0.76, 0.40], [0.64, 0.42]],
      cheekL: [[0.22, 0.58], [0.32, 0.54], [0.34, 0.66], [0.24, 0.70]],
      cheekR: [[0.60, 0.50], [0.82, 0.48], [0.84, 0.68], [0.62, 0.72]],
    };
    const [a, b] = blushPair(faceCardSvg("statement", EFFECTS, 4, FACE_B64, lm));
    const axis = (0.2 + 0.55 / 2) * 1000;
    expect(a!.grad).toBe(b!.grad);
    expect(Math.abs(a!.rx - b!.rx)).toBeLessThan(0.2);
    expect(Math.abs(a!.ry - b!.ry)).toBeLessThan(0.2);
    expect(Math.abs(a!.cy - b!.cy)).toBeLessThan(0.2);
    expect(Math.abs((axis - a!.cx) - (b!.cx - axis))).toBeLessThan(1.5);
  });

  it("does not invent a twin when both cheeks land on one side of the axis", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: 0.2, y: 0.12, w: 0.55, h: 0.7 },
      cheekL: [[0.22, 0.55], [0.30, 0.52], [0.32, 0.64], [0.24, 0.66]],
      cheekR: [[0.30, 0.56], [0.38, 0.53], [0.40, 0.66], [0.32, 0.68]],
    };
    const [a, b] = blushPair(faceCardSvg("lift", EFFECTS, 2, FACE_B64, lm));
    const axis = (0.2 + 0.55 / 2) * 1000;
    const mid = (a!.cx + b!.cx) / 2;
    expect(mid).toBeLessThan(axis - 40);
  });

  it("keeps a soft unclipped liner near its eye", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: 0.25, y: 0.15, w: 0.5, h: 0.6 },
      eyeL: [[0.60, 0.40], [0.70, 0.38], [0.72, 0.44], [0.62, 0.45]],
      eyeR: [[0.30, 0.40], [0.40, 0.38], [0.42, 0.44], [0.32, 0.45]],
    };
    const svg = faceCardSvg("anchor", [
      { category: "eye_liner", palettes: [{ color: "#221510", colorIntensity: 40 }] },
    ], 1, FACE_B64, lm);
    const placed = zonePaths(svg, "eye_liner");
    expect(placed).toHaveLength(2);
    expect(svg).not.toContain("<ellipse");
    const eyeCy = ((0.40 + 0.38 + 0.44 + 0.45) / 4) * 1250;
    for (const p of placed) {
      expect(p.fill).toBe("#221510");
      expect(Math.abs(p.cy - eyeCy)).toBeLessThan(50);
      expect(p.ry).toBeLessThanOrEqual(20);
      expect(p.rx / p.ry).toBeGreaterThan(2.5);
    }
  });

  it("does not drop cheek blush when the eye landmark sits below the cheek", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: 0.25, y: 0.1, w: 0.5, h: 0.75 },
      eyeL: [[0.32, 0.72], [0.42, 0.70], [0.44, 0.76], [0.34, 0.77]],
      eyeR: [[0.58, 0.72], [0.68, 0.70], [0.70, 0.76], [0.60, 0.77]],
      cheekL: [[0.28, 0.48], [0.40, 0.46], [0.42, 0.58], [0.30, 0.60]],
      cheekR: [[0.58, 0.48], [0.70, 0.46], [0.72, 0.58], [0.60, 0.60]],
    };
    const cheekCy = (0.48 + 0.46 + 0.58 + 0.60) / 4 * 1250;
    const [a] = blushPair(faceCardSvg("lift", EFFECTS, 1, FACE_B64, lm));
    expect(a!.cy).toBeLessThanOrEqual(cheekCy + 1);
  });

  it("drops non-finite landmarks and hostile strings instead of breaking the svg", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: Number.NaN, y: 0.1, w: 0.5, h: 0.6 },
      lip: [[Number.NaN, 0.7], [0.5, 0.7], [0.58, 0.68], [0.5, 0.74]],
      cheekL: [[Number.NaN, 0.5], [0.3, 0.5], [0.34, 0.6], [0.24, 0.62]],
      cheekR: [[0.6, 0.5], [0.7, 0.5], [0.72, 0.6], [0.62, 0.62]],
    };
    const svg = faceCardSvg("statement", [
      ...EFFECTS,
      { category: "blush", palettes: [{ color: '"><script>', colorIntensity: Number.NaN }] },
    ], 1, '"><script>alert(1)</script>', lm);
    expect(svg).not.toContain("NaN");
    expect(svg).not.toContain("<script>");
    expect(svg).toContain('flood-color="#b3122e"');
    expect(svg).toContain('stop-color="#e8a0a0"');
  });

  it("paints lift definition darker than the anchor palette color", () => {
    const lash = { category: "eyelashes" as const, palettes: [{ color: "#1a1010", colorIntensity: 40 }] };
    expect(faceCardSvg("lift", [lash], 1, FACE_B64)).toContain('fill="#241611"');
    expect(faceCardSvg("anchor", [lash], 1, FACE_B64)).toContain('fill="#1a1010"');
    expect(faceCardSvg("lift", [lash], 1, FACE_B64)).not.toContain("<ellipse");
  });

  it("mirrors unequal brows as thin ribbons", () => {
    const lm: FaceLandmarks = {
      faceBox: { x: 0.2, y: 0.1, w: 0.6, h: 0.7 },
      browL: [[0.24, 0.30], [0.36, 0.28], [0.38, 0.33], [0.26, 0.34]],
      browR: [[0.62, 0.26], [0.80, 0.24], [0.82, 0.32], [0.64, 0.34]],
    };
    const svg = faceCardSvg("statement", [
      { category: "eyebrows", palettes: [{ color: "#3a2417", colorIntensity: 50 }] },
    ], 5, FACE_B64, lm);
    const pair = zonePaths(svg, "eyebrows");
    expect(pair).toHaveLength(2);
    expect(pair[0]!.fill).toBe("#4a3226");
    const axis = (0.2 + 0.6 / 2) * 1000;
    const [a, b] = pair[0]!.cx <= pair[1]!.cx ? pair : [pair[1]!, pair[0]!];
    expect(Math.abs(a!.rx - b!.rx)).toBeLessThan(0.2);
    expect(Math.abs(a!.cy - b!.cy)).toBeLessThan(0.2);
    expect(Math.abs((axis - a!.cx) - (b!.cx - axis))).toBeLessThan(1.5);
    expect(a!.ry).toBeLessThanOrEqual(6);
    expect(b!.ry).toBeLessThanOrEqual(6);
  });

  it("prefers a supplied inner lip ring over the fissure", () => {
    const lm: FaceLandmarks = {
      ...LM,
      lipInner: [[0.48, 0.70], [0.52, 0.70], [0.52, 0.72], [0.48, 0.72]],
    };
    const svg = faceCardSvg("anchor", EFFECTS, 1, FACE_B64, lm);
    // the inner ring (0.48 -> 480px x) is present inside the lip path d
    const lip = svg.match(/data-zone="lip_color"[^>]*d="([^"]+)"/);
    expect(lip).not.toBeNull();
    const subs = lip![1]!.split(" Z").filter((x) => x.includes("M"));
    expect(subs.length).toBeGreaterThanOrEqual(2);
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('data-hole="inner"');
  });

  it("rejects an inner ring that would stamp the outer lip", () => {
    const lm: FaceLandmarks = { ...LM, lipInner: LM.lip };
    const svg = faceCardSvg("statement", EFFECTS, 1, FACE_B64, lm);
    expect(svg).toContain('data-hole="fissure"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).not.toContain("<ellipse");
  });
});

describe("lip composite", () => {
  const lip: [number, number, number] = [179, 18, 46];
  const hi: [number, number, number] = [226, 176, 168];
  const lo: [number, number, number] = [140, 78, 74];
  const lum = (c: readonly [number, number, number]) => 0.3 * c[0] + 0.59 * c[1] + 0.11 * c[2];

  it("keeps highlight above shadow and closer to camera luminance than a 0.55 soft-light stamp", () => {
    expect(LIP_COLOR_KEEP + LIP_DEPTH).toBeCloseTo(1, 5);
    const kept = applyLipComposite(hi, lip, 1);
    const flat = applyLipComposite(hi, lip, 1, 0.55);
    const shadow = applyLipComposite(lo, lip, 1);
    expect(lum(kept)).toBeGreaterThan(lum(shadow) + 25);
    expect(Math.abs(lum(kept) - lum(hi))).toBeLessThan(Math.abs(lum(flat) - lum(hi)));
    expect(kept[0]).toBeGreaterThan(kept[1]);
    expect(kept[0]).toBeGreaterThan(kept[2]);
    expect(applyLipComposite(hi, lip, 0)).toEqual(hi);
    expect(applyLipComposite([Number.NaN, 10, 10], lip, 1)[0]).toBeGreaterThanOrEqual(0);
  });

  it("collapses the feather skirt and leaves the lip core at the role alpha", () => {
    const statement = zoneAlpha("lip_color", 80, "statement");
    expect(lipMaskAlpha(1, statement)).toBeCloseTo(statement, 5);
    expect(lipMaskAlpha(0.35, statement)).toBeLessThan(lipMaskAlpha(1, statement) * 0.2);
    expect(lipMaskAlpha(0, statement)).toBe(0);
    expect(lipMaskAlpha(1, Number.NaN)).toBe(0);
    const anchor = zoneAlpha("lip_color", 80, "anchor");
    const lift = zoneAlpha("lip_color", 80, "lift");
    expect(anchor).toBeGreaterThan(0.2);
    expect(lift).toBeGreaterThan(anchor);
    expect(statement).toBeGreaterThan(lift);
  });
});

describe("soft LAB grade", () => {
  it("moves a/b fully and L only by the lightness weight", () => {
    const skin = srgbToLab(210, 170, 140);
    const lip = srgbToLab(179, 18, 46);
    expect(lip.a).toBeGreaterThan(40);
    expect(lip.L).toBeGreaterThan(25);
    expect(lip.L).toBeLessThan(55);
    const mixed = labLerp(skin, lip, 1, 0.25);
    expect(mixed.a).toBeCloseTo(lip.a, 5);
    expect(mixed.b).toBeCloseTo(lip.b, 5);
    expect(mixed.L).toBeCloseTo(skin.L + (lip.L - skin.L) * 0.25, 5);
    expect(labLerp(skin, lip, 0, 0.25)).toEqual(skin);
    expect(zoneLightness("eye_shadow")).toBeLessThanOrEqual(0.1);
    // lips left the LAB lerp (own sRGB stage); LAB lightness for lips is 0
    expect(zoneLightness("lip_color")).toBeCloseTo(0, 5);
    expect(zoneAlpha("blush", 70, "statement")).toBeGreaterThan(zoneAlpha("blush", 40, "statement") + 0.05);
  });

  it("round-trips the continuous transform and the filter tables", () => {
    const samples: Array<[number, number, number]> = [
      [179, 18, 46],
      [210, 170, 140],
      [80, 50, 40],
      [255, 255, 255],
      [128, 128, 128],
      [20, 16, 14],
    ];
    for (const [r, g, b] of samples) {
      const back = labToSrgb(srgbToLab(r, g, b));
      expect(Math.abs(back[0] - r)).toBeLessThan(2);
      expect(Math.abs(back[1] - g)).toBeLessThan(2);
      expect(Math.abs(back[2] - b)).toBeLessThan(2);
      const filtered = applySoftLab([r, g, b], [r, g, b], 0, 0.25);
      expect(Math.abs(filtered[0] - r)).toBeLessThan(3);
      expect(Math.abs(filtered[1] - g)).toBeLessThan(3);
      expect(Math.abs(filtered[2] - b)).toBeLessThan(3);
    }
    const graded = applySoftLab([210, 170, 140], [179, 18, 46], 1, 0.25);
    const labO = srgbToLab(graded[0], graded[1], graded[2]);
    const labS = srgbToLab(210, 170, 140);
    const labT = srgbToLab(179, 18, 46);
    expect(Math.abs(labO.L - (labS.L + (labT.L - labS.L) * 0.25))).toBeLessThan(4);
    expect(Math.abs(labO.a - labT.a)).toBeLessThan(6);
    expect(labO.a).toBeGreaterThan(labS.a + 20);
  });

  it("kernel is an odd face-scaled count", () => {
    expect(oddFeatherKernel(304)).toBe(19);
    expect(oddFeatherKernel(240)).toBe(15);
    expect(oddFeatherKernel(10)).toBe(3);
    expect(featherSigma(19)).toBeCloseTo(3.2, 5);
  });
});

describe("faceCardDataUrl", () => {
  it("returns a base64 svg data url wrapping the svg", () => {
    const url = faceCardDataUrl("anchor", EFFECTS, 1, FACE_B64);
    expect(url.startsWith("data:image/svg+xml;base64,")).toBe(true);
    const svg = Buffer.from(url.split(",")[1]!, "base64").toString("utf8");
    expect(svg).toContain(`data:image/jpeg;base64,${FACE_B64}`);
    expect(svg).not.toContain("<ellipse");
  });
});
