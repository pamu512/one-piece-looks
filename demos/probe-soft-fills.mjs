#!/usr/bin/env node
/**
 * Soft-fill probe (plan phase 2 step 2, 2026-10-25): the coach face map's
 * zone fills must stop reading as flat alpha stickers.
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
 * Writes OUT/{bare,warm,define}.png, OUT/side-by-side.png (bare | after),
 * and OUT/results.json. Set BEFORE=path/to/results.json to also print the
 * before -> after deltas. GATE=1 exits nonzero when a gate fails.
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
const GATE = process.env.GATE === "1";
const BEFORE = process.env.BEFORE && existsSync(process.env.BEFORE)
  ? JSON.parse(readFileSync(process.env.BEFORE, "utf8"))
  : null;
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { url: BASE, face: FACE, shape: null, zones: {}, gate: GATE, pass: [] };
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
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
});
const page = await context.newPage();
page.setDefaultTimeout(60000);
await page.addInitScript((faceDataUrl) => {
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
}, "data:image/png;base64," + faceB64);

await page.goto(BASE, { waitUntil: "domcontentloaded" });
const entry = await page.waitForSelector(".coach-back, .shutter:not([disabled])");
if ((await entry.getAttribute("class"))?.includes("coach-back")) await entry.click();
await page.waitForSelector(".shutter:not([disabled])");
await sleep(1200);
await page.click(".shutter");
await page.waitForSelector(".lock-ring");
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
  return b && !b.disabled;
});
await sleep(400);
await page.click("text=/See my three looks/i");
await page.waitForSelector(".look-frame img:not(.bare-img)");
await sleep(1500);
await page.click(".coach-pill");
await page.waitForSelector(".coach-map svg polygon");
await sleep(600);
results.shape = await page.$eval(".coach-sheet .sheet-title, .coach-note", () =>
  document.querySelector(".shape-word, .coach-note")?.textContent?.trim() ?? null).catch(() => null);

/** Filled polygons in doc order: {zone, points in screenshot px, centroid, radius, blend}. */
async function filledShapes() {
  const dsf = await page.evaluate(() => window.devicePixelRatio || 1);
  return page.$$eval(".coach-map svg polygon", (els, dsf) => {
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

async function shot(path) {
  await page.locator(".coach-map svg").screenshot({ path });
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
  const shapes = await filledShapes();
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
  const filled = await shot(join(OUT, `${tag}.png`));
  await page.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((p) => { p.style.visibility = "hidden"; });
  });
  const bare = await shot(join(OUT, "bare.png"));
  await page.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((p) => { p.style.visibility = ""; });
  });
  const cx = target.cx, cy = target.cy, core = Math.max(4, target.rw * 0.5);
  const tex = textureScore(filled, cx, cy, core) / (textureScore(bare, cx, cy, core) || 1);
  const { dRGB, dL } = coreDelta(filled, bare, cx, cy, core);
  const edge = edgeWidthPx(filled, bare, cx, cy, target.r);
  results.zones[tag] = { zone: target.zone, blend: target.blend, texture: +tex.toFixed(3), dRGB: +dRGB.toFixed(2), dL: +dL.toFixed(2), edgePx: +edge.toFixed(1), radiusPx: +target.r.toFixed(0), cx: +target.cx.toFixed(1), cy: +target.cy.toFixed(1), rw: +target.rw.toFixed(1) };
  const b = BEFORE?.zones?.[tag];
  const deltaTxt = b ? `  (before: tex ${b.texture}, edge ${b.edgePx}px, dRGB ${b.dRGB})` : "";
  console.log(`INFO  ${tag}  zone=${target.zone ?? "doc-order"} blend=${target.blend ?? "flat-alpha"} tex=${tex.toFixed(3)} edge=${edge.toFixed(1)}px dRGB=${dRGB.toFixed(2)} dL=${dL.toFixed(2)}${deltaTxt}`);
  return { tex, dRGB, dL, edge };
}

const blush = await measureChip("warm", "blush", (s) => pick(s, { zone: "cheek_apple_L" }) ?? s[0] ?? null);
const contour = await measureChip("define", "contour", (s) =>
  // Before this change there are no data-zone tags: with the define chip
  // active the filled polygons ARE the contour ribbons (the brow step has
  // no zones), so doc order falls through to a ribbon.
  pick(s, { zone: "cheek_shelf_L" }) ?? pick(s, { zone: "temple_L" }) ?? pick(s, { blend: "multiply" }) ?? s[0] ?? null);

await page.screenshot({ path: join(OUT, "coach-sheet.png") });

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

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
await browser.close();
const failed = results.pass.filter((g) => !g.pass);
console.log(failed.length ? `probe-soft-fills: FAIL (${failed.length} gates)` : "probe-soft-fills: OK");
process.exit(GATE && failed.length ? 1 : 0);
