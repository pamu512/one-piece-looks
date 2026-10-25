#!/usr/bin/env node
/**
 * Soft-fill probe (plan phase 2 steps 2 + 3, 2026-10-25): the coach face
 * map's zone fills must stop reading as flat alpha stickers (step 2) and
 * must stop painting hair and background (step 3).
 *
 * Drives the real client headlessly (fake-camera face, mock server behind
 * vite), opens the Face map sheet, and measures one blush zone and one
 * contour zone against the bare photo, per step chip:
 *
 *   texture  local-contrast ratio (mean 5x5 luma std, filled / bare) in
 *            the zone core. A flat alpha fill scales skin texture by
 *            (1 - alpha); blend-mode pigment keeps it. Gate: >= 0.75.
 *   edge     transition width in px (10% -> 90% of the pigment shift
 *            walking outside-in through the boundary). Gate: >= 8 px
 *            (a hard polygon edge is 1-3 px at deviceScaleFactor 2).
 *   pigment  mean |dRGB| in the core (gate >= 4) and, for contour
 *            (multiply), mean luma delta < -3: pigment present, depth
 *            darker, never invisible.
 *
 * Soft-mask gates (step 3) - the default build clips every pigment
 * polygon with a bisenet soft mask (skin probability x hair/bg
 * occlusion); ?softmasks=0 on the same build reproduces the step-2
 * geometry-only fill, so the A/B isolates the mask itself. Runs on the
 * tan diamond face, whose contour ribbons sit under real hair:
 *
 *   masks-present  pigment polygons carry SVG masks whose images decode
 *                  with real alpha (ORT runtime + model + parse all ran
 *                  in this browser). Gate.
 *   hair-drop      at interior points where the mask is CLOSED (alpha
 *                  < 0.15; with the pigment floor below, that is gate
 *                  closure - occ/skin removed >= 85% - not the polygon's
 *                  own feather falloff) and the step-2 build carried
 *                  pigment (|dRGB| >= 4), the masked build must drop
 *                  the summed pigment to <= 60%. Per point, not per
 *                  zone: a zone-mean ratio is diluted by its clear-skin
 *                  majority (seen: jaw zone-mean 82% while its closed
 *                  points read 49%). Gate.
 *   skin-keep      at interior points where the mask is OPEN (alpha
 *                  >= 0.9) and step-2 carried pigment, the masked build
 *                  keeps >= 60% of it and >= 4 |dRGB|: the mask
 *                  suppressed occlusion, not the step-2 look. Gate.
 *   mask-orders    the closed points' retained fraction must sit at
 *                  least 15 points below the open points': the mask
 *                  discriminates occlusion from skin (measured curve,
 *                  2026-10-25: 0.49 / 0.65 / 0.78 / 0.84 / 0.93 / 0.95
 *                  by alpha sixth), not a global pigment fade. Gate.
 *
 * Writes OUT/{bare,warm,define}.png, OUT/side-by-side.png (bare | after),
 * OUT/{all-tan-masked,all-tan-unmasked,bare-tan}.png, and OUT/results.json.
 * Set BEFORE=path/to/results.json to also print the before -> after
 * deltas. GATE=1 exits nonzero when a gate fails.
 *
 * Usage: node demos/probe-soft-fills.mjs
 * Needs: mock server :8787, vite :5173 (same stack pixel-gates.sh boots).
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.OUT ?? "/tmp/opl-soft-fills";
const BASE = "http://127.0.0.1:5173";
// The capture path yaw-gates at 0.06; the mask-qa faces classify cleanly
// (blonde -> pear yaw 0.004, tan -> diamond yaw 0.001) where the portrait
// fixtures sit just over the gate and never reach the face map.
const FACE = process.env.FACE ? join(ROOT, process.env.FACE) : join(ROOT, "demos/.mask-qa/faces/face-c-blonde.png");
// Step-3 A/B face: diamond -> temple ribbons run under real hair.
const TAN_FACE = process.env.TAN_FACE ? join(ROOT, process.env.TAN_FACE) : join(ROOT, "demos/.mask-qa/faces/face-d-tan.png");
const GATE = process.env.GATE === "1";
const BEFORE = process.env.BEFORE && existsSync(process.env.BEFORE)
  ? JSON.parse(readFileSync(process.env.BEFORE, "utf8"))
  : null;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { url: BASE, face: FACE, shape: null, zones: {}, softMask: null, gate: GATE, pass: [] };
function record(id, pass, detail) {
  results.pass.push({ id, pass });
  console.log(`${pass ? "PASS" : (GATE ? "FAIL" : "INFO")}  ${id}  ${detail}`);
}

/** Decode a png to raw rgb planes at its natural size. */
function planes(png) {
  const raw = png.replace(/\.png$/, ".rgb");
  const size = JSON.parse(spawnSync("ffprobe", ["-v", "quiet", "-print_format", "json", "-show_streams", png],
    { encoding: "utf8" }).stdout || "{}").streams?.[0] ?? {};
  const r = spawnSync("ffmpeg", ["-y", "-i", png, "-f", "rawvideo", "-pix_fmt", "rgb24", raw], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("png decode failed " + (r.stderr || "").slice(-200));
  return { rgb: readFileSync(raw), w: size.width, h: size.height };
}

const luma = (p, i) => 0.2126 * p.rgb[i] + 0.7152 * p.rgb[i + 1] + 0.0722 * p.rgb[i + 2];

/** Mean 5x5 luma std over a disc core: the skin-texture energy. */
function textureScore(p, cx, cy, r) {
  const L = (x, y) => luma(p, ((y | 0) * p.w + (x | 0)) * 3);
  let sum = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y += 2) for (let x = cx - r; x <= cx + r; x += 2) {
    if (Math.hypot(x - cx, y - cy) > r) continue;
    let m = 0; const vals = [];
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const v = L(x + dx, y + dy); vals.push(v); m += v; }
    m /= vals.length;
    let s = 0; for (const v of vals) s += (v - m) * (v - m);
    sum += Math.sqrt(s / vals.length); n++;
  }
  return n ? sum / n : 0;
}

/** Mean channel deltas (filled vs bare) over the core disc. */
function coreDelta(filled, bare, cx, cy, r) {
  let dr = 0, dg = 0, db = 0, dl = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y += 2) for (let x = cx - r; x <= cx + r; x += 2) {
    if (Math.hypot(x - cx, y - cy) > r) continue;
    const i = ((y | 0) * filled.w + (x | 0)) * 3;
    dr += Math.abs(filled.rgb[i] - bare.rgb[i]);
    dg += Math.abs(filled.rgb[i + 1] - bare.rgb[i + 1]);
    db += Math.abs(filled.rgb[i + 2] - bare.rgb[i + 2]);
    dl += luma(filled, i) - luma(bare, i);
    n++;
  }
  return { dRGB: n ? (dr + dg + db) / (3 * n) : 0, dL: n ? dl / n : 0 };
}

/** 10%->90% pigment-shift transition width along the outside-in ray. */
function edgeWidthPx(filled, bare, cx, cy, r) {
  const y = cy | 0;
  const step = Math.max(1, Math.round(r * 2) / 60);
  const xs = [];
  for (let x = cx - 1.8 * r; x < cx - 0.15 * r; x += step) {
    const i = (y * filled.w + (x | 0)) * 3;
    xs.push({ x, d: Math.abs(luma(filled, i) - luma(bare, i)) });
  }
  const inBand = xs.filter((p) => p.x > cx - 1.05 * r && p.x < cx - 0.25 * r);
  const plateau = Math.max(...inBand.map((p) => p.d), 0);
  if (!(plateau > 1)) return 0;
  const t10 = xs.find((p) => p.d >= 0.1 * plateau)?.x;
  const t90 = xs.find((p) => p.d >= 0.9 * plateau)?.x;
  if (t10 == null || t90 == null) return 0;
  return t90 - t10;
}

const faceB64 = readFileSync(FACE).toString("base64");
const tanB64 = readFileSync(TAN_FACE).toString("base64");
const browser = await chromium.launch({ headless: true });

/**
 * One driven session: fake-camera context on `face`, app at `url`,
 * through to the face map sheet open. Returns the page.
 */
async function drive(url, b64) {
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
  });
  const p = await context.newPage();
  p.setDefaultTimeout(60000);
  await p.addInitScript((faceDataUrl) => {
    let track = null;
    navigator.mediaDevices.getUserMedia = async () => {
      if (!track) {
        const img = new Image();
        img.src = faceDataUrl;
        await new Promise((r) => { img.onload = r; img.onerror = r; });
        const c = document.createElement("canvas");
        c.width = 480; c.height = 640;
        const ctx = c.getContext("2d");
        ctx.fillStyle = "#101014";
        ctx.fillRect(0, 0, 480, 640);
        const ar = img.naturalWidth / img.naturalHeight, tar = 480 / 640;
        let sw = img.naturalWidth, sh = img.naturalHeight;
        if (ar > tar) sw = sh * tar; else sh = sw / tar;
        ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, 480, 640);
        track = c.captureStream(12).getVideoTracks()[0];
      }
      return new MediaStream([track.clone()]);
    };
  }, "data:image/png;base64," + b64);

  await p.goto(url, { waitUntil: "domcontentloaded" });
  const entry = await p.waitForSelector(".coach-back, .shutter:not([disabled])");
  if ((await entry.getAttribute("class"))?.includes("coach-back")) await entry.click();
  await p.waitForSelector(".shutter:not([disabled])");
  await sleep(1200);
  await p.click(".shutter");
  await p.waitForSelector(".lock-ring");
  await p.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
    return b && !b.disabled;
  });
  await sleep(400);
  await p.click("text=/See my three looks/i");
  await p.waitForSelector(".look-frame img:not(.bare-img)");
  await sleep(1500);
  await p.click(".coach-pill");
  await p.waitForSelector(".coach-map svg polygon");
  await sleep(600);
  return p;
}

const page = await drive(BASE, faceB64);
results.shape = await page.$eval(".coach-sheet .sheet-title, .coach-note", () =>
  document.querySelector(".shape-word, .coach-note")?.textContent?.trim() ?? null).catch(() => null);

/** Filled polygons in doc order: {zone, points in screenshot px, centroid, radius, blend}. */
async function filledShapes(p) {
  const dsf = await p.evaluate(() => window.devicePixelRatio || 1);
  return p.$$eval(".coach-map svg polygon", (els, dsf) => {
    const svg = document.querySelector(".coach-map svg");
    const rect = svg.getBoundingClientRect();
    return els.filter((el) => el.getAttribute("fill") !== "none").map((el) => {
      const pts = (el.getAttribute("points") || "").trim().split(/\s+/).map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        // screenshot px: element-local CSS px * devicePixelRatio
        return { x: (x / 1000) * rect.width * dsf, y: (y / 1250) * rect.height * dsf };
      });
      const cx = pts.reduce((a, p) => a + p.x, 0) / pts.length;
      const cy = pts.reduce((a, p) => a + p.y, 0) / pts.length;
      return {
        zone: el.getAttribute("data-zone") || null,
        blend: el.getAttribute("data-blend") || null,
        cx, cy,
        r: Math.max(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))),
        // nearest-vertex distance ~ local half-width, so the core disc
        // stays inside thin ribbons (max radius would leave the stroke)
        rw: Math.min(...pts.map((p) => Math.hypot(p.x - cx, p.y - cy))),
      };
    });
  }, dsf);
}

async function shot(p, path) {
  await p.locator(".coach-map svg").screenshot({ path });
  return planes(path);
}

/** Pick a measurement target: prefer data-zone, fall back to doc order. */
function pick(shapes, { zone, blend, skip }) {
  return shapes.find((s) => zone && s.zone === zone)
    ?? shapes.find((s) => blend && s.blend === blend && (!skip || !skip.some((z) => z === s.zone)))
    ?? null;
}

// ---- chip: warm (blush zones, soft-light) ----
async function measureChip(chipText, tag, picker) {
  const chip = page.locator(".coach-steps .chip-vibe", { hasText: new RegExp(chipText, "i") }).first();
  await chip.click();
  await sleep(500);
  const shapes = await filledShapes(page);
  const target = picker(shapes);
  if (!target) { record(`${tag}-present`, false, "no filled polygon found"); return; }
  // Hide the crisp guide outlines for BOTH shots: the edge metric measures
  // the pigment feather, and a 2.5-unit vector stroke crossing the
  // scanline dominates the plateau (seen: a 7-luma spike on the tan face).
  await page.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((p) => {
      if (p.getAttribute("fill") === "none") p.style.visibility = "hidden";
    });
  });
  const filled = await shot(page, join(OUT, `${tag}.png`));
  await page.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((p) => { p.style.visibility = "hidden"; });
  });
  const bare = await shot(page, join(OUT, "bare.png"));
  await page.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((p) => { p.style.visibility = ""; });
  });
  const cx = target.cx, cy = target.cy, core = Math.max(4, target.rw * 0.5);
  const tex = textureScore(filled, cx, cy, core) / (textureScore(bare, cx, cy, core) || 1);
  const { dRGB, dL } = coreDelta(filled, bare, cx, cy, core);
  const edge = edgeWidthPx(filled, bare, cx, cy, target.r);
  results.zones[tag] = { zone: target.zone, blend: target.blend, texture: +tex.toFixed(3), dRGB: +dRGB.toFixed(2), dL: +dL.toFixed(2), edgePx: +edge.toFixed(1), radiusPx: +target.r.toFixed(0), cx: +cx.toFixed(1), cy: +cy.toFixed(1), rw: +target.rw.toFixed(1) };
  const b = BEFORE?.zones?.[tag];
  const deltaTxt = b ? `  (before: tex ${b.texture}, edge ${b.edgePx}px, dRGB ${b.dRGB})` : "";
  console.log(`INFO  ${tag}  zone=${target.zone ?? "doc-order"} blend=${target.blend ?? "flat-alpha"} tex=${tex.toFixed(3)} edge=${edge.toFixed(1)}px dRGB=${dRGB.toFixed(2)} dL=${dL.toFixed(2)}${deltaTxt}`);
  return { tex, dRGB, dL, edge, bare };
}

const blush = await measureChip("warm", "blush", (s) => pick(s, { zone: "cheek_apple_L" }) ?? s[0] ?? null);
const contour = await measureChip("define", "contour", (s) =>
  // Before this change there are no data-zone tags: with the define chip
  // active the filled polygons ARE the contour ribbons (the brow step has
  // no zones), so doc order falls through to a ribbon.
  pick(s, { zone: "cheek_shelf_L" }) ?? pick(s, { zone: "temple_L" }) ?? pick(s, { blend: "multiply" }) ?? s[0] ?? null);

await page.screenshot({ path: join(OUT, "coach-sheet.png") });

// ---- soft-mask gates (plan phase 2 step 3) ----

// masks-present: the pigments on THIS page (default face, masks on).
let maskedPolys = 0;
try {
  await page.waitForSelector(".coach-map svg polygon[mask]", { timeout: 45000 });
  await sleep(300);
  maskedPolys = await page.$$eval(".coach-map svg polygon[mask]", (els) => els.length);
} catch {
  maskedPolys = 0;
}
record("masks-present", maskedPolys > 0,
  `${maskedPolys} pigment polygons carry soft masks (ORT runtime + bisenet model served + parsed)`);

/**
 * Interior samples for every pigment zone on the All view: a grid of
 * points inside EXACTLY ONE pigment polygon (overlap-free attribution -
 * zones stack at the cheek/jaw edges, and a pixel two zones paint cannot
 * measure either zone's mask), with the mask alpha at each point from
 * that zone's mask. Returns samples in frame fractions plus the svg rect
 * for screenshot-px conversion.
 */
async function zoneSamples(p) {
  return p.evaluate(async () => {
    const svg = document.querySelector(".coach-map svg");
    if (!svg) return null;
    const rect = svg.getBoundingClientRect();
    const zones = [];
    for (const poly of svg.querySelectorAll("polygon[mask]")) {
      const zone = poly.getAttribute("data-zone") || "";
      const maskId = (poly.getAttribute("mask") || "").replace(/^url\(#|\)$/g, "");
      const imgEl = svg.querySelector(`mask[id="${maskId}"] image`);
      const href = imgEl && (imgEl.getAttribute("href") || imgEl.getAttributeNS("http://www.w3.org/1999/xlink", "href"));
      if (!href) continue;
      const pts = (poly.getAttribute("points") || "").trim().split(/\s+/).map((pair) => pair.split(",").map(Number));
      const inside = (x, y) => {
        let hit = false;
        for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
          const [xi, yi] = pts[i], [xj, yj] = pts[j];
          if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) hit = !hit;
        }
        return hit;
      };
      let alphaAt = null;
      try {
        const bmp = await new Promise((res, rej) => {
          const i = new Image();
          i.onload = () => res(i);
          i.onerror = () => rej(new Error("decode"));
          i.src = href;
        });
        const S = bmp.naturalWidth || 512;
        const c = document.createElement("canvas");
        c.width = S; c.height = S;
        const ctx = c.getContext("2d");
        ctx.drawImage(bmp, 0, 0, S, S);
        const d = ctx.getImageData(0, 0, S, S).data;
        // byte index (row * S + col) * 4 + 3 - alpha of pixel (col, row)
        alphaAt = (u, v) => d[(((v * S) | 0) * S + ((u * S) | 0)) * 4 + 3] / 255;
      } catch {
        continue; // undecodable mask: zone drops out of the A/B
      }
      zones.push({ zone, inside, alphaAt });
    }
    const S = 512;
    const byZone = new Map();
    for (let gy = 6; gy < S - 6; gy += 4) {
      for (let gx = 6; gx < S - 6; gx += 4) {
        const u = gx / S, v = gy / S;
        let hit = null, hits = 0;
        for (const z of zones) {
          if (!z.inside(u * 1000, v * 1250)) continue;
          hit = z; hits++;
          if (hits > 1) break; // shared pixel: not attributable
        }
        if (hits !== 1) continue;
        if (!byZone.has(hit.zone)) byZone.set(hit.zone, []);
        byZone.get(hit.zone).push({ u, v, a: hit.alphaAt(u, v) });
      }
    }
    return {
      rect: { w: rect.width, h: rect.height },
      zones: [...byZone].map(([zone, samples]) => ({ zone, samples })),
    };
  });
}

/** |dRGB| (filled vs bare) at one sample point, screenshot px. */
function drgbAt(filled, bare, s, rect) {
  const x = Math.round(s.u * rect.w * 2);
  const y = Math.round(s.v * rect.h * 2);
  if (x < 0 || y < 0 || x >= filled.w || y >= filled.h) return null;
  const i = (y * filled.w + x) * 3;
  return (Math.abs(filled.rgb[i] - bare.rgb[i])
    + Math.abs(filled.rgb[i + 1] - bare.rgb[i + 1])
    + Math.abs(filled.rgb[i + 2] - bare.rgb[i + 2])) / 3;
}

/** Mean |dRGB| (filled vs bare) over a zone's sample points, screenshot px. */
function zoneDrgb(filled, bare, samples, rect) {
  let sum = 0, n = 0;
  for (const s of samples) {
    const d = drgbAt(filled, bare, s, rect);
    if (d == null) continue;
    sum += d;
    n++;
  }
  return n ? sum / n : 0;
}

// A/B on the tan face: masked build vs ?softmasks=0 (step-2 fills).
async function tanAllShot(url, outFile, wantMask) {
  const p = await drive(url, tanB64);
  if (wantMask) {
    await p.waitForSelector(".coach-map svg polygon[mask]", { timeout: 45000 }).catch(() => {});
  }
  await p.locator(".coach-steps .chip-vibe", { hasText: /^All$/ }).first().click();
  await sleep(600);
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((el) => {
      if (el.getAttribute("fill") === "none") el.style.visibility = "hidden";
    });
  });
  const filled = await shot(p, join(OUT, outFile));
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((el) => { el.style.visibility = "hidden"; });
  });
  const bare = await shot(p, join(OUT, "bare-tan.png"));
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((el) => { el.style.visibility = ""; });
  });
  return { p, filled, bare };
}

const softMask = { face: TAN_FACE, zones: null };
if (maskedPolys > 0) {
  const masked = await tanAllShot(BASE, "all-tan-masked.png", true);
  const info = await zoneSamples(masked.p).catch(() => null);
  await masked.p.close();

  const unmasked = await tanAllShot(BASE + "?softmasks=0", "all-tan-unmasked.png", false);
  await unmasked.p.close();

  if (!info || info.zones.length === 0) {
    record("hair-drop", false, "no decodable soft masks on the All view");
  } else {
    // Per zone: mean mask alpha and mean |dRGB| over the same interior
    // sample points, masked build vs step-2 build (?softmasks=0) - the
    // INFO rows. The gates below judge per POINT, where the mask actually
    // closed or opened.
    const rows = [];
    const perPoint = [];
    for (const z of info.zones) {
      if (z.samples.length < 12) continue;
      const meanA = z.samples.reduce((a, s) => a + s.a, 0) / z.samples.length;
      const dM = zoneDrgb(masked.filled, masked.bare, z.samples, info.rect);
      const dU = zoneDrgb(unmasked.filled, unmasked.bare, z.samples, info.rect);
      rows.push({ zone: z.zone, n: z.samples.length, meanA, dMasked: dM, dUnmasked: dU });
      console.log(`INFO  softmask-zone  ${z.zone} n=${z.samples.length} meanAlpha=${meanA.toFixed(2)} dRGB masked=${dM.toFixed(2)} unmasked=${dU.toFixed(2)}`);
      for (const s of z.samples) {
        const m = drgbAt(masked.filled, masked.bare, s, info.rect);
        const u = drgbAt(unmasked.filled, unmasked.bare, s, info.rect);
        if (m == null || u == null) continue;
        perPoint.push({ a: s.a, m, u });
      }
    }
    softMask.zones = rows.map((r) => ({ ...r, meanA: +r.meanA.toFixed(3), dMasked: +r.dMasked.toFixed(2), dUnmasked: +r.dUnmasked.toFixed(2) }));
    results.softMask = softMask;
    writeFileSync(join(OUT, "perpoint.json"), JSON.stringify(perPoint.map((r) => ({
      a: +r.a.toFixed(3), m: +r.m.toFixed(2), u: +r.u.toFixed(2),
    }))));
    writeFileSync(join(OUT, "sampled-zones.json"), JSON.stringify(info.zones.map((z) => ({
      zone: z.zone,
      samples: z.samples.map((s) => ({ u: +s.u.toFixed(4), v: +s.v.toFixed(4), a: +s.a.toFixed(3) })),
    }))));

    // hair-drop: where the mask closed on pigment step-2 carried, the
    // masked build must kill most of it. alpha < 0.15 under the u >= 4
    // floor is gate closure, not the polygon's feather falloff (a point
    // whose own coverage is < 0.15 cannot carry |dRGB| >= 4 through
    // soft-light/multiply at these opacities).
    const closed = perPoint.filter((r) => r.a < 0.15 && r.u >= 4);
    const openKeep = perPoint.filter((r) => r.a >= 0.9 && r.u >= 4);
    const bands = [[0, 0.15], [0.15, 0.35], [0.35, 0.55], [0.55, 0.75], [0.75, 0.9], [0.9, 1.01]]
      .map(([lo, hi]) => {
        const rs = perPoint.filter((r) => r.a >= lo && r.a < hi && r.u >= 4);
        const m = rs.reduce((x, r) => x + r.m, 0);
        const u = rs.reduce((x, r) => x + r.u, 0);
        return { lo, hi, n: rs.length, retained: u > 0 ? +(m / u).toFixed(3) : null };
      });
    softMask.gates = {
      closedPoints: closed.length,
      openPoints: openKeep.length,
      closedMasked: +closed.reduce((x, r) => x + r.m, 0).toFixed(1),
      closedUnmasked: +closed.reduce((x, r) => x + r.u, 0).toFixed(1),
      openMasked: +openKeep.reduce((x, r) => x + r.m, 0).toFixed(1),
      openUnmasked: +openKeep.reduce((x, r) => x + r.u, 0).toFixed(1),
      bands,
    };
    if (closed.length < 5 || openKeep.length === 0) {
      record("hair-drop", false, `too few ${closed.length < 5 ? "closed" : "open"} pigmented sample points (closed=${closed.length}, open=${openKeep.length}) - the mask never closes on carried pigment`);
      record("skin-keep", openKeep.length > 0, `open pigmented sample points: ${openKeep.length}`);
    } else {
      const cRatio = softMask.gates.closedMasked / softMask.gates.closedUnmasked;
      record("hair-drop", cRatio <= 0.6,
        `${closed.length} closed points: |dRGB| sum ${softMask.gates.closedMasked} vs unmasked ${softMask.gates.closedUnmasked} = ${(cRatio * 100).toFixed(0)}% (gate <= 60%)`);
      const oMean = softMask.gates.openMasked / openKeep.length;
      const oRatio = softMask.gates.openMasked / softMask.gates.openUnmasked;
      record("skin-keep", oMean >= 4 && oRatio >= 0.6,
        `${openKeep.length} open points: |dRGB| mean ${oMean.toFixed(2)}, ${(oRatio * 100).toFixed(0)}% of unmasked (gate >= 4 and >= 60%)`);
      record("mask-orders", cRatio + 0.15 <= oRatio,
        `closed ${cRatio.toFixed(2)} vs open ${oRatio.toFixed(2)} (gate: gap >= 0.15)`);
    }
  }
}

// Gates (only meaningful on the blend-mode build; before runs just record).
if (GATE) {
  if (blush) {
    record("blush-texture", blush.tex >= 0.75, `texture ratio ${blush.tex.toFixed(3)} >= 0.75`);
    record("blush-edge", blush.edge >= 8, `edge ${blush.edge.toFixed(1)}px >= 8px`);
    record("blush-pigment", blush.dRGB >= 4, `mean |dRGB| ${blush.dRGB.toFixed(2)} >= 4`);
  }
  if (contour) {
    record("contour-texture", contour.tex >= 0.6, `texture ratio ${contour.tex.toFixed(3)} >= 0.6`);
    record("contour-depth", contour.dL <= -3, `luma delta ${contour.dL.toFixed(2)} <= -3`);
  }
}

// Side-by-side: bare | warm | define at equal height.
const side = spawnSync("ffmpeg", ["-y",
  "-i", join(OUT, "bare.png"), "-i", join(OUT, "blush.png"), "-i", join(OUT, "contour.png"),
  "-filter_complex", "[0][1][2]hstack=inputs=3", join(OUT, "side-by-side.png")], { encoding: "utf8" });
if (side.status !== 0) console.log("WARN  side-by-side failed: " + (side.stderr || "").slice(-200));
// Step-3 A/B side: masked | unmasked on the tan face.
if (existsSync(join(OUT, "all-tan-unmasked.png"))) {
  const side3 = spawnSync("ffmpeg", ["-y",
    "-i", join(OUT, "bare-tan.png"), "-i", join(OUT, "all-tan-masked.png"), "-i", join(OUT, "all-tan-unmasked.png"),
    "-filter_complex", "[0][1][2]hstack=inputs=3", join(OUT, "side-by-side-softmask.png")], { encoding: "utf8" });
  if (side3.status !== 0) console.log("WARN  softmask side-by-side failed: " + (side3.stderr || "").slice(-200));
}

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
await browser.close();
const failed = results.pass.filter((g) => !g.pass);
console.log(failed.length ? `probe-soft-fills: FAIL (${failed.length} gates)` : "probe-soft-fills: OK");
process.exit(GATE && failed.length ? 1 : 0);
