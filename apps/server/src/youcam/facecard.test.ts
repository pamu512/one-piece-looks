/**
 * Face compositor tests: the mock render is the session photo plus soft
 * LAB paint. No eye ellipses. Lip hex stays put while role scales alpha.
 */
import { describe, it, expect } from "vitest";
import {
  applyLipComposite,
  applyLipMeanShift,
  applyLipTexture,
  applySoftLab,
  blushFalloff,
  blushMaskWeight,
  blushSpread,
  faceCardDataUrl,
  faceCardSvg,
  featherSigma,
  interEyePx,
  labLerp,
  labMatrixText,
  labToSrgb,
  lipEdgeRamp,
  lipEdgeTransfer,
  lipFleshBand,
  lipMaskAlpha,
  lipMeanShiftDelta,
  lipPaintEdge,
  lipVermillionEdge,
  LIP_COLOR_KEEP,
  LIP_DEPTH,
  LIP_EDGE_HI,
  LIP_FEATHER_KNEE,
  LIP_MASK_GAMMA,
  LIP_SMALL_PX,
  LIP_THIN_PX,
  oddFeatherKernel,
  srgbToLab,
  zoneAlpha,
  zoneLightness,
  type FaceLandmarks,
  type LipMeans,
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

  it("paints a closed lip as one fill and never an ellipse", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    expect(svg).not.toContain('fill-rule="evenodd"');
    expect(svg).not.toContain('data-hole=');
    expect(svg).not.toContain("<ellipse");
    expect(svg).not.toContain("<clipPath");
    const lip = svg.match(/data-zone="lip_color"[^>]*d="([^"]+)"/);
    expect(lip).not.toBeNull();
    const subs = lip![1]!.split(" Z").filter((s) => s.includes("M"));
    expect(subs).toHaveLength(1);
  });

  it("falls back to shelf paths without landmarks", () => {
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64);
    expect(svg).not.toContain("<clipPath");
    expect(svg).not.toContain("<ellipse");
    expect(svg).toContain("<path");
    expect(svg).not.toContain("data-hole=");
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
    expect(lipPath).not.toContain('fill-rule="evenodd"');
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

  it("erodes the lip 1 to 3 px and feathers 1 to 3 px without clipping to the hard outline", () => {
    const svg = faceCardSvg("statement", EFFECTS, 7, FACE_B64, LM);
    const support = oddFeatherKernel(interEyePx(LM), 0.06);
    const morph = svg.match(/<feMorphology in="lpsh" operator="erode" radius="(\d+)" result="lper"\/>/);
    const blur = svg.match(/<feGaussianBlur in="lper" stdDeviation="([0-9.]+)" result="lpbl"\/>/);
    expect(morph).not.toBeNull();
    expect(blur).not.toBeNull();
    const radius = Number(morph![1]);
    const sigma = Number(blur![1]);
    expect(radius).toBeGreaterThanOrEqual(1);
    expect(radius).toBeLessThanOrEqual(3);
    expect(sigma).toBeGreaterThanOrEqual(1);
    expect(sigma).toBeLessThanOrEqual(3);
    expect(radius).toBeLessThan(support);
    expect(sigma).toBeLessThan(featherSigma(support));
    expect(svg).not.toContain('<feComposite in="lpbl" in2="lpsh" operator="in" result="lpcl"/>');
    expect(svg).toContain('<feOffset in="lpbl" dx="0" dy="0" result="lpcl"/>');
    expect(svg).not.toContain("lphd");
    expect(svg).not.toMatch(/<feMorphology in="lpsh"[^>]*operator="dilate"/);
    expect(svg).toContain('mode="color"');
    expect(svg).toContain('mode="soft-light"');
    const lip = zonePaths(svg, "lip_color")[0];
    expect(lip).toBeTruthy();
    expect(svg).toContain(`data-kernel="${radius}"`);
    const edge = lipPaintEdge(LM);
    expect(radius).toBe(edge.radius);
    expect(sigma).toBeCloseTo(edge.sigma, 3);
    expect(blur![1]).toBe(edge.sigmaText);
    const lipTag = svg.match(/data-zone="lip_color"[^>]*>/)![0]!;
    expect(attr(lipTag, "data-sigma")).toBe(edge.sigmaText);
    expect(attr(lipTag, "data-sigma")).toBe(blur![1]);
    expect(lipVermillionEdge(Number.NaN, Number.NaN).radius).toBeGreaterThanOrEqual(1);
    expect(lipVermillionEdge(Number.NaN, Number.NaN).radius).toBeLessThanOrEqual(3);
  });

  it("feather sigma uses the unrounded ry, so 37.49 stays 1.687", () => {
    const bare = lipVermillionEdge(240, 37.49);
    expect(bare.sigmaText).toBe(Math.min(3, Math.max(1, 37.49 * 0.045)).toFixed(3));
    expect(bare.sigmaText).toBe("1.687");
    expect(bare.sigma).toBeCloseTo(1.687, 3);
    const fromDataRy = lipVermillionEdge(240, Number((37.49).toFixed(1)));
    expect(fromDataRy.sigmaText).toBe("1.688");
    const y0 = 850 / 1250;
    const y1 = (850 + 74.98) / 1250;
    const lm: FaceLandmarks = {
      ...LM,
      lip: [[0.42, y0], [0.58, y0], [0.58, y1], [0.42, y1]],
    };
    const edge = lipPaintEdge(lm);
    const svg = faceCardSvg("statement", EFFECTS, 7, FACE_B64, lm);
    const blur = svg.match(/<feGaussianBlur in="lper" stdDeviation="([0-9.]+)" result="lpbl"\/>/);
    const lipTag = svg.match(/data-zone="lip_color"[^>]*>/)![0]!;
    expect(blur).not.toBeNull();
    expect(blur![1]).toBe(edge.sigmaText);
    expect(attr(lipTag, "data-sigma")).toBe(edge.sigmaText);
    expect(Number(blur![1])).toBeCloseTo(edge.sigma, 3);
    expect(edge.sigmaText).toBe("1.687");
    expect(lipVermillionEdge(interEyePx(lm), Number(attr(lipTag, "data-ry"))).sigmaText).toBe("1.688");
  });

  it("feathers blush toward the cheekbone and keeps shadow on a thin lid shelf", () => {
    const svg = faceCardSvg("lift", [
      ...EFFECTS,
      { category: "eye_shadow", palettes: [{ color: "#8a4038", colorIntensity: 50 }] },
    ], 1, FACE_B64, LM);
    expect(svg).toMatch(/<radialGradient id="g-blush[^"]*" cx="0.5" cy="0.5"/);
    expect(svg).toContain('offset="1" stop-color="#e8a0a0" stop-opacity="0"');
    expect(svg).toContain('data-skin="1"');
    expect(svg).not.toContain("<ellipse");
    const pair = blushPair(svg);
    for (const cheek of pair) expect(Math.abs(cheek.rx - cheek.ry)).toBeLessThan(0.2);
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

  it("cuts a hole only when lipInner is present", () => {
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
    expect(svg).not.toContain("data-hole=");
    expect(svg).not.toContain('fill-rule="evenodd"');
    expect(svg).not.toContain("<ellipse");
  });

  it("keeps a thin wide inner gap inside the lip", () => {
    const ring = (rx: number, ry: number, n: number): [number, number][] => {
      const pts: [number, number][] = [];
      for (let i = 0; i < n; i++) {
        const t = (i / n) * Math.PI * 2;
        pts.push([0.5 + Math.cos(t) * rx, 0.7 + Math.sin(t) * ry]);
      }
      return pts;
    };
    // Inner rx is 0.956 of the outer, which ellipse-ratio checks reject at 0.92.
    const svg = faceCardSvg("anchor", EFFECTS, 1, FACE_B64, {
      ...LM,
      lip: ring(0.09, 0.035, 24),
      lipInner: ring(0.086, 0.008, 18),
    });
    expect(svg).toContain('data-hole="inner"');
    expect(svg).toContain('fill-rule="evenodd"');
    expect(svg).toContain('<feComposite in="lpbl" in2="lphd" operator="out" result="lpcl"/>');
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

  it("shifts lip L toward #b3122e, keeps per-pixel variance, and ranks statement above lift above anchor", () => {
    const lipstick: [number, number, number] = [179, 18, 46];
    const samples: Array<[number, number, number]> = [
      [220, 160, 150],
      [190, 120, 110],
      [235, 175, 165],
      [160, 90, 80],
    ];
    const targetL = srgbToLab(lipstick[0], lipstick[1], lipstick[2]).L;
    const plain = samples.map((px) => srgbToLab(...applyLipTexture(px, lipstick, 1, undefined, "statement")).L);
    const plainMean = plain.reduce((a, b) => a + b, 0) / plain.length;
    const plainVar = plain.reduce((a, b) => a + (b - plainMean) ** 2, 0) / plain.length;
    const lipMeanL = plainMean;
    const stats = (role: string) => {
      const Ls = samples.map((px) => srgbToLab(...applyLipTexture(px, lipstick, 1, lipMeanL, role)).L);
      const mean = Ls.reduce((a, b) => a + b, 0) / Ls.length;
      const variance = Ls.reduce((a, b) => a + (b - mean) ** 2, 0) / Ls.length;
      return { mean, variance };
    };
    const anchor = stats("anchor");
    const lift = stats("lift");
    const statement = stats("statement");
    expect(Math.abs(anchor.mean - targetL)).toBeLessThan(Math.abs(plainMean - targetL));
    expect(Math.abs(lift.mean - targetL)).toBeLessThan(Math.abs(anchor.mean - targetL));
    expect(Math.abs(statement.mean - targetL)).toBeLessThan(Math.abs(lift.mean - targetL));
    expect(statement.variance).toBeGreaterThan(plainVar * 0.8);
    expect(applyLipTexture(samples[0]!, lipstick, 0, lipMeanL, "statement")).toEqual(
      applyLipComposite(samples[0]!, lipstick, 0),
    );
    const svg = (role: string) => faceCardSvg(role, EFFECTS, 7, FACE_B64, { ...LM, lipMeanL: 72 });
    const bias = (role: string) => {
      const m = svg(role).match(/1\.000000 0\.000000 0\.000000 0\.000000 (-?[0-9.]+) 0\.000000 1\.000000/);
      expect(m).not.toBeNull();
      return Number(m![1]);
    };
    expect(svg("statement")).toContain('data-shift="0.60"');
    expect(svg("lift")).toContain('data-shift="0.55"');
    expect(svg("anchor")).toContain('data-shift="0.50"');
    expect(svg("statement")).toContain('data-lmean="72.00"');
    expect(Math.abs(bias("statement"))).toBeGreaterThan(Math.abs(bias("lift")));
    expect(Math.abs(bias("lift"))).toBeGreaterThan(Math.abs(bias("anchor")));
    expect(faceCardSvg("statement", EFFECTS, 7, FACE_B64, LM)).not.toContain("data-lmean=");
  });

  it("shifts fair and tan lips toward #b3122e in one LAB pass and keeps L texture", () => {
    const lipstick: [number, number, number] = [179, 18, 46];
    const target = srgbToLab(lipstick[0], lipstick[1], lipstick[2]);
    const hue = (lab: { a: number; b: number }) => Math.atan2(lab.b, lab.a) * 180 / Math.PI;
    const hueDelta = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    // CIE76. The filter shift is affine in encoded LAB, then read back in Lab.
    const de76 = (p: { L: number; a: number; b: number }, q: { L: number; a: number; b: number }) =>
      Math.hypot(p.L - q.L, p.a - q.a, p.b - q.b);
    const std = (xs: number[]) => {
      const m = xs.reduce((a, b) => a + b, 0) / xs.length;
      return Math.sqrt(xs.reduce((a, b) => a + (b - m) ** 2, 0) / xs.length);
    };
    const around = (rgb: [number, number, number]): Array<[number, number, number]> => {
      const base = srgbToLab(rgb[0], rgb[1], rgb[2]);
      return [-15, -7.5, 0, 7.5, 15].map((dL) => labToSrgb({ L: base.L + dL, a: base.a, b: base.b }));
    };
    const paint = (samples: Array<[number, number, number]>, role: string) => {
      const labs = samples.map((px) => srgbToLab(px[0], px[1], px[2]));
      const means = {
        L: labs.reduce((a, b) => a + b.L, 0) / labs.length,
        a: labs.reduce((a, b) => a + b.a, 0) / labs.length,
        b: labs.reduce((a, b) => a + b.b, 0) / labs.length,
      };
      const out = samples.map((px) => srgbToLab(...applyLipMeanShift(px, lipstick, 1, means, role)));
      const mean = {
        L: out.reduce((a, b) => a + b.L, 0) / out.length,
        a: out.reduce((a, b) => a + b.a, 0) / out.length,
        b: out.reduce((a, b) => a + b.b, 0) / out.length,
      };
      return {
        mean,
        deTarget: de76(mean, target),
        deBare: de76(mean, means),
        lStdIn: std(labs.map((l) => l.L)),
        lStdOut: std(out.map((l) => l.L)),
        hue: hue(mean),
      };
    };
    for (const rgb of [[205, 125, 120], [165, 95, 85]] as Array<[number, number, number]>) {
      const statement = paint(around(rgb), "statement");
      expect(statement.deTarget).toBeLessThanOrEqual(8);
      expect(hueDelta(statement.hue, hue(target))).toBeLessThanOrEqual(10);
      expect(statement.lStdOut).toBeGreaterThanOrEqual(statement.lStdIn * 0.7);
      const anchor = paint(around(rgb), "anchor");
      const lift = paint(around(rgb), "lift");
      expect(anchor.deBare).toBeLessThan(lift.deBare);
      expect(lift.deBare).toBeLessThan(statement.deBare);
    }
    const fair = around([205, 125, 120]);
    const fairLabs = fair.map((px) => srgbToLab(px[0], px[1], px[2]));
    const means = {
      L: fairLabs.reduce((a, b) => a + b.L, 0) / fairLabs.length,
      a: fairLabs.reduce((a, b) => a + b.a, 0) / fairLabs.length,
      b: fairLabs.reduce((a, b) => a + b.b, 0) / fairLabs.length,
    };
    expect(applyLipMeanShift(fair[0]!, lipstick, 0, means, "statement")).toEqual(fair[0]);
    const delta = lipMeanShiftDelta(lipstick, means, 1);
    expect(delta).not.toBeNull();
    const targetLab = srgbToLab(lipstick[0], lipstick[1], lipstick[2]);
    expect(delta!.dL * 100).toBeCloseTo(targetLab.L - means.L, 5);
    expect(delta!.dA * 255).toBeCloseTo(targetLab.a - means.a, 5);
    expect(delta!.dB * 255).toBeCloseTo(targetLab.b - means.b, 5);
    const partial = { L: means.L, a: Number.NaN, b: means.b };
    const mask = lipMaskAlpha(1, zoneAlpha("lip_color", 80, "statement"));
    expect(applyLipMeanShift(fair[0]!, lipstick, 1, partial, "statement")).toEqual(
      applyLipTexture(fair[0]!, lipstick, mask, means.L, "statement"),
    );
    const onlyL = faceCardSvg("statement", EFFECTS, 7, FACE_B64, { ...LM, lipMeanL: 70, lipMeanA: 40 });
    expect(onlyL).toContain('mode="color"');
    expect(onlyL).toContain('data-shift="0.60"');
    expect(onlyL).toContain('data-lmean="70.00"');
    expect(onlyL).not.toContain("data-amean=");
    const badA = faceCardSvg("statement", EFFECTS, 7, FACE_B64, {
      ...LM, lipMeanL: 70, lipMeanA: 400, lipMeanB: 10,
    });
    expect(badA).toContain('mode="color"');
    expect(badA).not.toContain('data-shift="1.00"');
    const card = faceCardSvg("statement", EFFECTS, 7, FACE_B64, { ...LM, lipMeanL: means.L, lipMeanA: means.a, lipMeanB: means.b });
    expect(card).toContain('data-shift="1.00"');
    expect(card).toContain(`data-amean="${means.a.toFixed(2)}"`);
    expect(card).toContain(`data-bmean="${means.b.toFixed(2)}"`);
    expect(card).toContain(delta!.dL.toFixed(6));
    expect(card).toContain(delta!.dA.toFixed(6));
    expect(card).toContain(delta!.dB.toFixed(6));
    expect(card).not.toContain('mode="color"');
    expect(card).not.toContain('mode="soft-light"');
    const alpha = (role: string) => zonePaths(faceCardSvg(role, EFFECTS, 7, FACE_B64, {
      ...LM, lipMeanL: means.L, lipMeanA: means.a, lipMeanB: means.b,
    }), "lip_color")[0]!.alpha;
    expect(alpha("anchor")).toBeLessThan(alpha("lift"));
    expect(alpha("lift")).toBeLessThan(alpha("statement"));
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

describe("lip edge scale", () => {
  it("shrinks erode, feather, and the hole guard on a thin band and keeps a normal lip in 1 to 3 px", () => {
    const normal = lipVermillionEdge(240, 37.49);
    expect(normal.measure).toBeCloseTo(74.98, 2);
    expect(normal.edgeRamp).toBe(false);
    expect(normal.radius).toBe(3);
    expect(normal.sigma).toBeGreaterThanOrEqual(1);
    expect(normal.sigma).toBeLessThanOrEqual(3);
    expect(normal.sigmaText).toBe("1.687");
    expect(normal.guard).toBeGreaterThanOrEqual(1);
    expect(normal.guard).toBeLessThanOrEqual(3);

    const thin = lipVermillionEdge(240, 5, 10);
    expect(thin.measure).toBeCloseTo(10, 5);
    expect(thin.measure).toBeLessThan(LIP_THIN_PX);
    expect(thin.edgeRamp).toBe(true);
    expect(thin.radius).toBe(0);
    expect(thin.sigma).toBeLessThan(1);
    expect(thin.sigma).toBeGreaterThan(0.2);
    expect(thin.guard).toBe(0);
    expect(thin.sigma).toBeLessThan(normal.sigma);
    // 0.08 of the band, and under the 1.5 px cap.
    expect(Math.min(1.5, 0.08 * thin.measure)).toBeLessThan(1);

    const wide = lipFleshBand(
      [[0, 0], [80, 0], [80, 40], [0, 40]],
      [[10, 16], [70, 16], [70, 24], [10, 24]],
    );
    expect(wide).toBeGreaterThan(8);
    expect(wide).toBeLessThan(40);
  });

  it("omits the integer erode on a tiny mouth and keeps gamma on a normal one", () => {
    const tiny: FaceLandmarks = {
      ...LM,
      lip: [[0.48, 0.70], [0.52, 0.70], [0.52, 0.708], [0.48, 0.708]],
    };
    const svg = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, tiny);
    expect(svg).not.toMatch(/<feMorphology in="lpsh" operator="erode"/);
    expect(svg).toContain('data-ramp="edge"');
    const edge = lipPaintEdge(tiny);
    // Replaces intercept "-5.2500": the cutoff window is still 0.42..0.5.
    // A shorter band slides it, and the SVG linear transfer matches lipEdgeRamp.
    const ramp = lipEdgeTransfer(edge.measure);
    const { lo, hi } = ramp;
    expect(ramp.slopeText).toBe("12.5000");
    expect(svg).toContain(`slope="${ramp.slopeText}"`);
    expect(svg).toContain(`intercept="${ramp.interceptText}"`);
    expect(hi).toBeCloseTo(0.22, 2);
    expect(lo).toBeCloseTo(0.14, 2);
    const cutoffTx = lipEdgeTransfer(LIP_THIN_PX);
    expect(cutoffTx.slopeText).toBe("12.5000");
    expect(cutoffTx.interceptText).toBe("-5.2500");
    expect(hi).toBeLessThan(LIP_EDGE_HI);
    expect(Number(ramp.interceptText)).toBeGreaterThan(-5.25);
    expect(edge.edgeRamp).toBe(true);
    expect(edge.radius).toBe(0);
    expect(edge.sigma).toBeLessThan(1);
    const normal = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, LM);
    expect(normal).toContain(`exponent="${LIP_MASK_GAMMA.toFixed(3)}"`);
    expect(normal).toContain('data-ramp="gamma"');
    const statement = zoneAlpha("lip_color", 80, "statement");
    const anchor = zoneAlpha("lip_color", 80, "anchor");
    const lift = zoneAlpha("lip_color", 80, "lift");
    expect(lipMaskAlpha(0.5, statement, true)).toBeCloseTo(statement, 5);
    expect(lipMaskAlpha(0.3, statement, true)).toBe(0);
    expect(lipMaskAlpha(0.5, statement, false)).toBeLessThan(statement * 0.3);
    const short = edge.measure;
    expect(lipMaskAlpha(0.5, anchor, true, short)).toBeCloseTo(anchor, 5);
    expect(lipMaskAlpha(hi, anchor, true, short)).toBeCloseTo(anchor, 5);
    expect(lipMaskAlpha(0.5, anchor, true, short)).toBeLessThan(lipMaskAlpha(0.5, lift, true, short));
    expect(lipMaskAlpha(0.5, lift, true, short)).toBeLessThan(lipMaskAlpha(0.5, statement, true, short));
    for (const c of [0, lo * 0.5, lo, (lo + hi) / 2, hi, 0.5, 1]) {
      const linear = Math.min(1, Math.max(0, (c - lo) / (hi - lo)));
      expect(lipMaskAlpha(c, anchor, true, short)).toBeCloseTo(linear * anchor, 5);
    }
    const cutoff = lipEdgeRamp(LIP_THIN_PX);
    expect(cutoff.lo).toBeCloseTo(0.42, 5);
    expect(cutoff.hi).toBeCloseTo(0.5, 5);
    const px: [number, number, number] = [150, 80, 70];
    const edgeMeans: LipMeans = { L: 40, a: 20, b: 12 };
    const onEdge = applyLipMeanShift(px, [179, 18, 46], 0.5, edgeMeans, "statement", 80, true);
    const skirt = applyLipMeanShift(px, [179, 18, 46], 0.5, edgeMeans, "statement", 80, false);
    expect(onEdge).not.toEqual(skirt);
    expect(lipMaskAlpha(1, anchor, true)).toBeLessThan(lipMaskAlpha(1, lift, true));
    expect(lipMaskAlpha(1, lift, true)).toBeLessThan(lipMaskAlpha(1, statement, true));
  });

  it("slides the thin ramp with lip size and matches the SVG linear transfer", () => {
    const anchor = zoneAlpha("lip_color", 80, "anchor");
    const at = (px: number) => lipEdgeRamp(px).hi;
    expect(at(6)).toBeCloseTo(at(8), 5);
    expect(at(8)).toBeLessThan(at(10));
    expect(at(10)).toBeLessThan(at(12));
    expect(at(12)).toBeLessThan(at(14));
    expect(at(14)).toBeCloseTo(0.5, 5);
    expect(at(10)).toBeCloseTo(0.22, 4);
    expect(lipEdgeRamp(10).lo).toBeCloseTo(0.14, 4);
    expect(lipMaskAlpha(lipEdgeRamp(10).lo, anchor, true, 10)).toBe(0);
    expect(lipMaskAlpha(at(10), anchor, true, 10)).toBeCloseTo(anchor, 5);
    expect(lipMaskAlpha(Number.NaN, anchor, true, 10)).toBe(0);
    expect(lipMaskAlpha(-1, anchor, true, 10)).toBe(0);
    expect(lipEdgeRamp(Number.NaN)).toEqual(lipEdgeRamp(LIP_THIN_PX));
    expect(lipEdgeRamp(0)).toEqual(lipEdgeRamp(LIP_THIN_PX));
    expect(lipEdgeRamp(-4)).toEqual(lipEdgeRamp(LIP_THIN_PX));
    const quantized = (c: number, measure: number) => {
      const t = lipEdgeTransfer(measure);
      const y = Number(t.slopeText) * c + Number(t.interceptText);
      return Math.min(1, Math.max(0, y));
    };
    for (const measure of [8, 10, 12, LIP_THIN_PX, 20]) {
      expect(quantized(0.5, measure)).toBeGreaterThanOrEqual(0.999);
      for (let i = 0; i <= 20; i++) {
        const c = i / 20;
        const exact = lipMaskAlpha(c, 1, true, measure);
        expect(Math.abs(quantized(c, measure) - exact)).toBeLessThan(5e-4);
      }
    }
    const under = lipVermillionEdge(240, (LIP_SMALL_PX - 2) / 2, 10);
    expect(under.edgeRamp).toBe(true);
    expect(under.measure).toBeCloseTo(10, 5);
    expect(under.radius).toBe(0);
    expect(lipEdgeRamp(under.measure).hi).toBeCloseTo(0.22, 2);
    // Band-keyed smallness (2026-10-10): a tall mouth with a thin band
    // (face-test: full 56.08 over the threshold, band 12.8) is small WHERE
    // IT PAINTS. Full-height keying left it on the 2.5px-erode normal path,
    // paring the band ~40% — the probe-measured under-fill.
    const over = lipVermillionEdge(240, (LIP_SMALL_PX + 2) / 2, 10);
    expect(over.edgeRamp).toBe(true);
    expect(over.measure).toBeCloseTo(10, 5);
    expect(over.radius).toBe(0);
    expect(lipVermillionEdge(240, (LIP_SMALL_PX + 2) / 2).edgeRamp).toBe(false);
    expect(lipVermillionEdge(240, 37.49, 0).sigmaText).toBe("1.687");
    expect(lipVermillionEdge(Number.POSITIVE_INFINITY, 37.49).sigma).toBeLessThanOrEqual(3);
  });

  it("keeps a tall mouth on a 1 to 3 px erode and holds the feather at the knee", () => {
    const tall = lipVermillionEdge(400, 60);
    const capped = (Math.min(120, LIP_FEATHER_KNEE) * 0.5) * 0.045;
    expect(tall.measure).toBeCloseTo(120, 5);
    expect(tall.edgeRamp).toBe(false);
    expect(tall.sigmaText).toBe(Math.min(3, Math.max(1, capped)).toFixed(3));
    expect(tall.sigma).toBeLessThanOrEqual(2);
    expect(tall.sigma).toBeGreaterThanOrEqual(1);
    expect(tall.radius).toBe(3);
    const guardFromCappedFeather = Math.min(tall.sigma, 0.12 * tall.measure);
    const guardIfCapped = guardFromCappedFeather < 1 ? 0 : Math.min(3, Math.round(guardFromCappedFeather));
    expect(tall.guard).toBeGreaterThanOrEqual(guardIfCapped);
    expect(tall.guard).toBeGreaterThanOrEqual(1);
    expect(tall.guard).toBeLessThanOrEqual(3);

    const glossy = lipVermillionEdge(400, 45, 16);
    expect(glossy.measure).toBeCloseTo(16, 5);
    expect(glossy.measure).toBeGreaterThanOrEqual(LIP_THIN_PX);
    // 16px band on a 90px mouth: band-keyed smallness puts this on the thin
    // ramp (erode 1.28 -> radius 1, vs the old radius-3 that pared the
    // band); the probe showed the normal path under-paints this shape.
    expect(glossy.edgeRamp).toBe(true);
    expect(glossy.radius).toBe(1);
    expect(glossy.sigma).toBeGreaterThanOrEqual(0.2);
    expect(glossy.guard).toBeLessThanOrEqual(3);

    const narrowOnTall = lipVermillionEdge(400, 40, 10);
    expect(narrowOnTall.measure).toBeCloseTo(10, 5);
    expect(narrowOnTall.measure).toBeLessThan(LIP_THIN_PX);
    expect(40 * 2).toBeGreaterThanOrEqual(LIP_SMALL_PX);
    // 10px band on an 80px mouth: same band-keyed smallness — thin ramp, no
    // erode. Full-height keying (edgeRamp false, radius 3) was the bug.
    expect(narrowOnTall.edgeRamp).toBe(true);
    expect(narrowOnTall.radius).toBe(0);
    expect(narrowOnTall.sigma).toBeGreaterThanOrEqual(0.2);
  });
});

/** CIEDE2000. Self-checked against the Sharma pair (about 2.0425). */
function deltaE00(
  l1: number, a1: number, b1: number,
  l2: number, a2: number, b2: number,
): number {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const c1 = Math.hypot(a1, b1);
  const c2 = Math.hypot(a2, b2);
  const cb = (c1 + c2) / 2;
  const cb7 = cb ** 7;
  const g = 0.5 * (1 - Math.sqrt(cb7 / (cb7 + 25 ** 7)));
  const a1p = (1 + g) * a1;
  const a2p = (1 + g) * a2;
  const c1p = Math.hypot(a1p, b1);
  const c2p = Math.hypot(a2p, b2);
  const h1 = (Math.atan2(b1, a1p) * deg + 360) % 360;
  const h2 = (Math.atan2(b2, a2p) * deg + 360) % 360;
  let dh = 0;
  if (c1p * c2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dL = l2 - l1;
  const dC = c2p - c1p;
  const dH = 2 * Math.sqrt(c1p * c2p) * Math.sin((dh / 2) * rad);
  const lBar = (l1 + l2) / 2;
  const cBar = (c1p + c2p) / 2;
  let hBar = h1 + h2;
  if (c1p * c2p !== 0) {
    if (Math.abs(h1 - h2) <= 180) hBar = (h1 + h2) / 2;
    else if (h1 + h2 < 360) hBar = (h1 + h2 + 360) / 2;
    else hBar = (h1 + h2 - 360) / 2;
  }
  const t = 1
    - 0.17 * Math.cos((hBar - 30) * rad)
    + 0.24 * Math.cos(2 * hBar * rad)
    + 0.32 * Math.cos((3 * hBar + 6) * rad)
    - 0.20 * Math.cos((4 * hBar - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hBar - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(cBar ** 7 / (cBar ** 7 + 25 ** 7));
  const sl = 1 + (0.015 * (lBar - 50) ** 2) / Math.sqrt(20 + (lBar - 50) ** 2);
  const sc = 1 + 0.045 * cBar;
  const sh = 1 + 0.015 * cBar * t;
  const rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / sl) ** 2 + (dC / sc) ** 2 + (dH / sh) ** 2 + rt * (dC / sc) * (dH / sh));
}

describe("statement lip shift", () => {
  const lipstick: [number, number, number] = [179, 18, 46];

  it("matches the published CIEDE2000 pair", () => {
    const d = deltaE00(50, 2.6772, -79.7751, 50, 0, -82.7485);
    expect(d).toBeGreaterThan(2.0);
    expect(d).toBeLessThan(2.1);
  });

  it("keeps a bright highlight on the same hue as the mid lip", () => {
    const hue = (lab: { a: number; b: number }) => (Math.atan2(lab.b, lab.a) * 180) / Math.PI;
    const hueDelta = (a: number, b: number) => {
      const d = Math.abs(a - b) % 360;
      return d > 180 ? 360 - d : d;
    };
    const mid: [number, number, number] = [168, 92, 84];
    const highlight: [number, number, number] = [236, 170, 160];
    const bare = srgbToLab(mid[0], mid[1], mid[2]);
    const means: LipMeans = { L: bare.L, a: bare.a, b: bare.b };
    const midOut = srgbToLab(...applyLipMeanShift(mid, lipstick, 1, means, "statement"));
    const hiOut = srgbToLab(...applyLipMeanShift(highlight, lipstick, 1, means, "statement"));
    expect(hueDelta(hue(midOut), hue(hiOut))).toBeLessThanOrEqual(6);
    expect(hiOut.L).toBeGreaterThan(midOut.L + 8);
    expect(hiOut.a).toBeGreaterThan(20);
    expect(hiOut.b).toBeGreaterThan(8);
    const delta = lipMeanShiftDelta(lipstick, means, 1, 80);
    expect(delta).not.toBeNull();
    const target = srgbToLab(lipstick[0], lipstick[1], lipstick[2]);
    expect(delta!.dL * 100).toBeCloseTo(target.L - means.L, 5);
    expect(delta!.dA * 255).toBeCloseTo(target.a - means.a, 5);
    expect(delta!.dB * 255).toBeCloseTo(target.b - means.b, 5);
  });

  it("shifts the unveiled photo and composites the lip over the veiled base", () => {
    const barePx: [number, number, number] = [176, 98, 88];
    const veiled: [number, number, number] = [148, 86, 70];
    const bareLab = srgbToLab(barePx[0], barePx[1], barePx[2]);
    const means: LipMeans = { L: bareLab.L, a: bareLab.a, b: bareLab.b };
    const fromBare = applyLipMeanShift(barePx, lipstick, 1, means, "statement");
    const fromVeil = applyLipMeanShift(veiled, lipstick, 1, means, "statement");
    const laid = applyLipMeanShift(veiled, lipstick, 1, means, "statement", 80, false, barePx);
    const dist = (a: readonly number[], b: readonly number[]) =>
      Math.hypot((a[0] ?? 0) - (b[0] ?? 0), (a[1] ?? 0) - (b[1] ?? 0), (a[2] ?? 0) - (b[2] ?? 0));
    expect(dist(laid, fromBare)).toBeLessThan(dist(fromVeil, fromBare));
    const card = faceCardSvg("statement", EFFECTS, 7, FACE_B64, {
      ...LM,
      lipMeanL: means.L,
      lipMeanA: means.a,
      lipMeanB: means.b,
    });
    expect(card).toContain('<feComponentTransfer in="src" result="lpeln"');
    expect(card).toContain('<feComponentTransfer in="lpew" result="lpes"');
    expect(card).toContain('<feColorMatrix in="lpes" result="lpddf"');
    expect(card).toContain('<feBlend in="lpsd" in2="veo" mode="normal" result="lpout"/>');
    const delta = lipMeanShiftDelta(lipstick, means, 1, 80);
    expect(delta).not.toBeNull();
    expect(card).toContain(delta!.dL.toFixed(6));
    expect(card).toContain(delta!.dA.toFixed(6));
    expect(card).toContain(delta!.dB.toFixed(6));
    const anchor = faceCardSvg("anchor", EFFECTS, 7, FACE_B64, {
      ...LM,
      lipMeanL: means.L,
      lipMeanA: means.a,
      lipMeanB: means.b,
    });
    expect(anchor).toContain(delta!.dL.toFixed(6));
    expect(zonePaths(anchor, "lip_color")[0]!.alpha).toBeLessThan(zonePaths(card, "lip_color")[0]!.alpha);
  });

  it("blends a partial lip from the unveiled shift onto the veiled pixel", () => {
    const bare: [number, number, number] = [176, 98, 88];
    const veiled: [number, number, number] = [148, 86, 70];
    const bareLab = srgbToLab(bare[0], bare[1], bare[2]);
    const means: LipMeans = { L: bareLab.L, a: bareLab.a, b: bareLab.b };
    const full = applyLipMeanShift(bare, lipstick, 1, means, "statement");
    const laid = applyLipMeanShift(veiled, lipstick, 0.5, means, "statement", 80, false, bare);
    const fromVeil = applyLipMeanShift(veiled, lipstick, 0.5, means, "statement");
    expect(laid).not.toEqual(fromVeil);
    expect(laid).not.toEqual(veiled);
    for (let i = 0; i < 3; i++) {
      const lo = Math.min(veiled[i]!, full[i]!);
      const hi = Math.max(veiled[i]!, full[i]!);
      expect(laid[i]!).toBeGreaterThanOrEqual(lo - 1);
      expect(laid[i]!).toBeLessThanOrEqual(hi + 1);
    }
    const faded = applyLipMeanShift(veiled, lipstick, 0, means, "statement", 80, false, bare);
    expect(faded).toEqual(veiled);
  });
});

describe("blush gaussian", () => {
  it("falls off smoothly, stays circular, and is zero off the skin", () => {
    const { sigma } = blushSpread(240);
    expect(sigma).toBeCloseTo(240 * 0.28, 5);
    let prev = blushFalloff(0, sigma);
    expect(prev).toBeCloseTo(1, 5);
    for (let d = 2; d <= sigma * 4; d += 2) {
      const v = blushFalloff(d, sigma);
      expect(prev - v).toBeGreaterThanOrEqual(-1e-9);
      expect(prev - v).toBeLessThan(0.08);
      prev = v;
    }
    expect(blushFalloff(sigma * 4, sigma)).toBeLessThan(0.01);
    expect(blushMaskWeight(10, sigma, false)).toBe(0);
    expect(blushMaskWeight(10, sigma, true)).toBeCloseTo(blushFalloff(10, sigma), 8);
    const svg = faceCardSvg("statement", EFFECTS, 4, FACE_B64, LM);
    const pair = blushPair(svg);
    expect(Math.abs(pair[0]!.rx - pair[0]!.ry)).toBeLessThan(0.2);
    expect(Math.abs(pair[1]!.rx - pair[1]!.ry)).toBeLessThan(0.2);
    expect(svg).toContain('data-skin="1"');
    const ops = [...svg.matchAll(/stop-color="#e8a0a0" stop-opacity="([^"]+)"/g)].map((m) => Number(m[1]));
    expect(ops.length).toBeGreaterThanOrEqual(17);
    expect(ops[0]).toBeGreaterThan(0.95);
    expect(ops[ops.length - 1]).toBe(0);
    for (let i = 1; i < ops.length; i++) {
      expect(ops[i - 1]! - ops[i]!).toBeGreaterThanOrEqual(-1e-9);
      expect(ops[i - 1]! - ops[i]!).toBeLessThan(0.12);
    }
    const anchor = zoneAlpha("blush", 50, "anchor");
    const lift = zoneAlpha("blush", 50, "lift");
    const statement = zoneAlpha("blush", 50, "statement");
    expect(anchor).toBeLessThan(lift);
    expect(lift).toBeLessThan(statement);
  });
});
