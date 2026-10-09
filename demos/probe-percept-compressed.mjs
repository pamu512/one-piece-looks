#!/usr/bin/env node
/**
 * Perception probe on COMPRESSED output (Autoclaw verdict A1-A4, 2026-10-07).
 * Drives the real client (vite :5173 + mock server :8787) with the fake
 * camera per face, rasterizes Anchor/Lift/Statement + bare from the DOM,
 * re-encodes each frame at H.264 crf28 (phone-video proxy), and measures:
 *
 *   A1  face-band (the client detector's faceBox) mean luma delta >= 3.0
 *       for Anchor<->Lift AND Lift<->Statement, on every probed face.
 *   A2  cheek pair mirrored about the face-box axis (size, height, one
 *       falloff) AND |alphaL-alphaR| <= 20% of combined alpha (L+R).
 *       Luma |L-R| / (L+R) is printed with that line. Feather: p95
 *       horizontal gradient inside the blush patches vs the bare's own.
 *   A3  first paint: >= 80% of the final visual delta within 500ms of the
 *       first worn img mounting; switch paint: same, clocked from the
 *       thumbnail tap's scroll event.
 *   A4  warmth: Lab a* on cheek and under-eye regions >= bare baseline
 *       (tolerance -0.5) on all three looks.
 *
 * Usage: node demos/probe-percept-compressed.mjs
 * Env: FACES="face-c-blonde,face-d-tan" (default: both)
 */
import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const ROOT = process.env.OPL_ROOT ?? join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = process.env.OUT ?? "/tmp/opl-percept";
const FACES = (process.env.FACES ?? "face-c-blonde,face-d-tan").split(",");
const BASE = "http://127.0.0.1:5173";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) { try { unlinkSync(join(OUT, f)); } catch {} }

const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
if (!health?.ok || health.mock !== true) throw new Error("need mock server on :8787");
if ((await fetch(BASE).then((r) => r.status)) !== 200) throw new Error("vite not up on :5173");

/** png -> H.264 crf28 single frame -> png (phone-video proxy). */
function compress(pngIn, pngOut) {
  const mp4 = pngOut.replace(/\.png$/, ".mp4");
  const e1 = spawnSync("ffmpeg", ["-y", "-i", pngIn, "-vf", "scale=1000:1250", "-c:v", "libx264", "-crf", "28", "-pix_fmt", "yuv420p", "-frames:v", "1", mp4], { encoding: "utf8" });
  if (e1.status !== 0) throw new Error("ffmpeg encode failed: " + e1.stderr?.slice(-400));
  const e2 = spawnSync("ffmpeg", ["-y", "-i", mp4, "-frames:v", "1", pngOut], { encoding: "utf8" });
  if (e2.status !== 0) throw new Error("ffmpeg decode failed: " + e2.stderr?.slice(-400));
}

let planeSeq = 0;
/** Decode a png to raw rgb24 at 500x625. */
function readPlanes(png) {
  const raw = png.replace(/\.png$/, `.p${planeSeq++}.rgb`);
  const r = spawnSync("ffmpeg", ["-y", "-i", png, "-vf", "scale=500:625", "-f", "rawvideo", "-pix_fmt", "rgb24", raw], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("rgb decode failed " + r.stderr?.slice(-200));
  return { rgb: readFileSync(raw), w: 500, h: 625 };
}

const lumAt = (f, x, y) => {
  const i = ((y | 0) * f.w + (x | 0)) * 3;
  return 0.299 * f.rgb[i] + 0.587 * f.rgb[i + 1] + 0.114 * f.rgb[i + 2];
};

/** Mean per-pixel |luma difference| between two frames over a window. */
function winAbsMean(a, b, x0f, y0f, x1f, y1f) {
  let s = 0, n = 0;
  for (let y = Math.round(y0f * a.h); y < y1f * a.h; y++) {
    for (let x = Math.round(x0f * a.w); x < x1f * a.w; x++) {
      s += Math.abs(lumAt(a, x, y) - lumAt(b, x, y)); n++;
    }
  }
  return n ? s / n : 0;
}

function winMean(f, x0f, y0f, x1f, y1f) {
  let s = 0, n = 0;
  for (let y = Math.round(y0f * f.h); y < y1f * f.h; y++) {
    for (let x = Math.round(x0f * f.w); x < x1f * f.w; x++) {
      s += lumAt(f, x, y); n++;
    }
  }
  return n ? s / n : 0;
}

/** Least-squares alpha of (look ~= bare + alpha * (tint - bare)) in a
 * window, fitted over all three RGB channels: the applied-strength
 * estimate. Invariant to the base photo's own L/R contrast, which raw
 * deltas are not. RGB (not luma) because a warm tint can sit at nearly the
 * same luma as the skin it covers - the channel difference carries the
 * signal (ill-conditioned luma fits were the source of phantom asymmetry
 * on deeper tones). */
function winAlpha(look, bare, tintHex, x0f, y0f, x1f, y1f) {
  const tc = [0, 1, 2].map((k) => parseInt(tintHex.slice(1 + k * 2, 3 + k * 2), 16));
  // Veil nuisance direction (SAW-mask fix added a full-face warm tint on
  // statement; the fit must isolate the BLUSH alpha). Regress out the
  // constant veil color direction first: residual obs/dirs are orthogonal
  // to it, so the fitted blush alpha no longer swings with veil depth.
  // Per-pixel pair (obs, dir): subtract the mean delta color over the
  // window (the veil's local contribution, approx constant in the window)
  // from BOTH obs and dir. The blush tint varies with the underlying skin,
  // so a constant-color nuisance removal keeps the blush signal while
  // canceling the veil's near-uniform shift (Gram-Schmidt on the mean).
  const pts = [];
  for (let y = Math.round(y0f * look.h); y < y1f * look.h; y++) {
    for (let x = Math.round(x0f * look.w); x < x1f * look.w; x++) {
      const i = ((y | 0) * look.w + (x | 0)) * 3;
      for (let c = 0; c < 3; c++) {
        pts.push([tc[c] - bare.rgb[i + c], look.rgb[i + c] - bare.rgb[i + c]]);
      }
    }
  }
  if (pts.length === 0) return NaN;
  const mO = pts.reduce((s, q) => s + q[0], 0) / pts.length;
  const mD = pts.reduce((s, q) => s + q[1], 0) / pts.length;
  let sxy = 0, sxx = 0;
  for (const [dir0, obs0] of pts) {
    const dir = dir0 - mO;
    const obs = obs0 - mD;
    sxy += dir * obs; sxx += dir * dir;
  }
  return sxx > 1e-6 ? sxy / sxx : NaN;
}

function winGrad(f, x0f, y0f, x1f, y1f) {
  const gs = [];
  for (let y = Math.round(y0f * f.h); y < y1f * f.h; y++) {
    for (let x = Math.round(x0f * f.w); x < x1f * f.w - 1; x++) {
      gs.push(Math.abs(lumAt(f, x + 1, y) - lumAt(f, x, y)));
    }
  }
  gs.sort((a, b) => a - b);
  if (gs.length === 0) return { max: 0, p95: 0 };
  return { max: gs[gs.length - 1], p95: gs[Math.floor(gs.length * 0.95)] };
}

function winAstar(f, x0f, y0f, x1f, y1f) {
  let sa = 0, n = 0;
  const lin = (c) => { const s = c / 255; return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
  const f2 = (t) => (t > 0.008856 ? t ** (1 / 3) : 7.787 * t + 16 / 116);
  for (let y = Math.round(y0f * f.h); y < y1f * f.h; y += 2) {
    for (let x = Math.round(x0f * f.w); x < x1f * f.w; x += 2) {
      const i = ((y | 0) * f.w + (x | 0)) * 3;
      const R = lin(f.rgb[i]), G = lin(f.rgb[i + 1]), B = lin(f.rgb[i + 2]);
      const X = (R * 0.4124 + G * 0.3576 + B * 0.1805) / 0.95047;
      const Y = R * 0.2126 + G * 0.7152 + B * 0.0722;
      const Z = (R * 0.0193 + G * 0.1192 + B * 0.9505) / 1.08883;
      sa += 500 * (f2(X) - f2(Y)); n++;
    }
  }
  return n ? sa / n : 0;
}

function svgText(dataUrl) {
  const comma = dataUrl.indexOf(",");
  return Buffer.from(dataUrl.slice(comma + 1), "base64").toString("utf8");
}

function pathAttr(tag, name) {
  const m = tag.match(new RegExp(`\\b${name}="([^"]*)"`));
  return m ? m[1] : null;
}

/** Blush shelves: soft cheek paths, not ellipses. */
function blushGeometry(dataUrl) {
  const svg = svgText(dataUrl);
  const els = [];
  for (const tag of svg.match(/<path\b[^>]*>/g) ?? []) {
    if (pathAttr(tag, "data-zone") !== "blush") continue;
    els.push({
      cx: Number(pathAttr(tag, "data-cx")),
      cy: Number(pathAttr(tag, "data-cy")),
      rx: Number(pathAttr(tag, "data-rx")),
      ry: Number(pathAttr(tag, "data-ry")),
      grad: pathAttr(tag, "data-grad"),
    });
  }
  return els;
}

/** Parse blush windows + tint out of a faceCard SVG data URL. */
function blushWindows(dataUrl) {
  const svg = svgText(dataUrl);
  const wins = [];
  let tint = null;
  for (const tag of svg.match(/<path\b[^>]*>/g) ?? []) {
    if (pathAttr(tag, "data-zone") !== "blush") continue;
    tint = tint ?? pathAttr(tag, "data-tint");
    const fx = Number(pathAttr(tag, "data-cx")) / 1000;
    const fy = Number(pathAttr(tag, "data-cy")) / 1250;
    const frx = Number(pathAttr(tag, "data-rx")) / 1000;
    const fry = Number(pathAttr(tag, "data-ry")) / 1250;
    // Fit window = LOWER core of the raised blush patch: the patch is lifted
    // to the cheekbone, so a full-core window would reach into the eye/lash
    // zone and the fit would mix lash deltas into the cheek alpha.
    wins.push({ x0: fx - frx * 0.6, x1: fx + frx * 0.6, y0: fy - fry * 0.2, y1: fy + fry * 0.6, side: fx < 0.5 ? "L" : "R" });
  }
  return { wins, tint };
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${detail}`);
}

const browser = await chromium.launch({ headless: true });

for (const face of FACES) {
  const facePath = join(ROOT, "demos/.mask-qa/faces", `${face}.png`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

  const faceB64 = readFileSync(facePath).toString("base64");
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
  await page.waitForSelector(".shutter:not([disabled])");
  await sleep(1500);
  await page.click(".shutter");
  await page.waitForSelector(".lock-ring");

  const lockLabel = await page.getAttribute(".lock-ring", "aria-label");
  if (!/lip/i.test(lockLabel || "")) {
    await page.click('.mini-btn:has-text("Adjust")');
    await sleep(400);
    const box = await page.locator("canvas").first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.445, box.y + box.height * 0.70);
    await sleep(600);
    const keep = page.locator("button", { hasText: /Keep it/i });
    if (await keep.isVisible().catch(() => false)) { await keep.click(); await sleep(400); }
  }

  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
    return b && !b.disabled;
  });
  await sleep(600);

  // A3 clock: first worn img element that gets a src.
  await page.evaluate(() => {
    window.__firstImgAt = null;
    const obs = new MutationObserver(() => {
      if (window.__firstImgAt) return;
      const img = document.querySelector(".look-frame img:not(.bare-img)");
      if (img && img.getAttribute("src")) window.__firstImgAt = performance.now();
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true });
  });

  const frameLoc = page.locator(".look-frame").first();
  await page.click("text=/See my three looks/i");
  await page.waitForFunction(() => window.__firstImgAt !== null, null, { timeout: 30000 });
  // A3 first paint, sampled at rAF cadence: computed opacity of the worn img
  // from mount (decode already happened under the veil). >= 0.8 opacity ==
  // >= 80% of the final visual delta delivered.
  const fadeSamples = await page.evaluate(() => new Promise((res) => {
    const samples = [];
    const tick = () => {
      const img = document.querySelector(".look-frame img:not(.bare-img)");
      const t = window.__firstImgAt === null ? -1 : performance.now() - window.__firstImgAt;
      samples.push({ t, opacity: img ? Number(getComputedStyle(img).opacity) : -1 });
      const last = samples[samples.length - 1];
      if (last.t > 900 || samples.length > 120) return res(samples);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const fadeShotFinal = (await page.screenshot()).toString("base64");

  // A3b: switch anchor->lift clocked from the strip's first scroll event.
  await page.click('.thumbs .thumb:nth-child(1)');
  await sleep(900);
  await page.evaluate(() => {
    window.__switchT0 = null;
    document.querySelector(".look-strip")?.addEventListener("scroll", () => {
      if (window.__switchT0 === null) window.__switchT0 = performance.now();
    }, { passive: true, once: true });
  });
  const preShot = (await page.screenshot()).toString("base64");
  await page.click('.thumbs .thumb:nth-child(2)');
  // A3 switch: time from the scroll event to the first rAF with the strip
  // parked at the target slide (content move complete; compositor paints it
  // within the same frame budget).
  const switchRun = await page.evaluate(() => new Promise((res) => {
    const strip = document.querySelector(".look-strip");
    const target = strip.clientWidth;
    const samples = [];
    const tick = () => {
      const t = window.__switchT0 === null ? -1 : performance.now() - window.__switchT0;
      samples.push({ t, left: strip.scrollLeft });
      const last = samples[samples.length - 1];
      if (last.t > 900 || samples.length > 120 || (last.t >= 0 && Math.abs(strip.scrollLeft - target) < 1)) {
        return res({ target, samples });
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }));
  const switchSamples = switchRun.samples;
  const switchTarget = switchRun.target;
  await sleep(1500);
  const switchFinal = (await page.screenshot()).toString("base64");

  // Full-res rasters + served SVGs for window/tint parsing.
  const frames = await page.evaluate(() => {
    const grab = (sel) => {
      const img = document.querySelector(sel);
      if (!img) return null;
      const c = document.createElement("canvas");
      c.width = img.naturalWidth || 1000;
      c.height = img.naturalHeight || 1250;
      c.getContext("2d").drawImage(img, 0, 0);
      return { png: c.toDataURL("image/png"), src: img.src };
    };
    const roles = ["anchor", "lift", "statement"];
    const out = { bare: grab(".look-slide:nth-child(1) .bare-img") };
    for (let i = 1; i <= 3; i++) out[roles[i - 1]] = grab(`.look-slide:nth-child(${i}) img:not(.bare-img)`);
    return out;
  });
  if (!frames.anchor || !frames.lift || !frames.statement || !frames.bare) throw new Error("missing frames for " + face);
  for (const [role, f] of Object.entries(frames)) {
    writeFileSync(join(OUT, `${face}-${role}-raw.png`), Buffer.from(f.png.split(",")[1], "base64"));
    compress(join(OUT, `${face}-${role}-raw.png`), join(OUT, `${face}-${role}-c28.png`));
  }
  const F = {};   // compressed planes (A1)
  const R = {};   // raw planes (A2/A4)
  for (const role of ["anchor", "lift", "statement", "bare"]) {
    F[role] = readPlanes(join(OUT, `${face}-${role}-c28.png`));
    R[role] = readPlanes(join(OUT, `${face}-${role}-raw.png`));
  }

  // faceBox: re-run the client's own detector on the bare photo in-page.
  const faceBox = await page.evaluate(async () => {
    const mod = await import("/src/lib/face.ts");
    const img = document.querySelector(".look-slide:nth-child(1) .bare-img");
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = 1000; c.height = 1250;
    const ctx = c.getContext("2d");
    ctx.drawImage(img, 0, 0, 1000, 1250);
    const lm = await mod.detectFaceWithModel(c);
    return lm ? lm.faceBox : null;
  });
  if (!faceBox) throw new Error("no faceBox for " + face);
  const band = { x0: faceBox.x, x1: faceBox.x + faceBox.w, y0: faceBox.y, y1: faceBox.y + faceBox.h };
  console.log(`\n=== ${face} (faceBox x ${faceBox.x.toFixed(2)}..${(faceBox.x + faceBox.w).toFixed(2)} y ${faceBox.y.toFixed(2)}..${(faceBox.y + faceBox.h).toFixed(2)}) ===`);

  // ---- A1: mean per-pixel |luma delta| over the face band (the verdict's
  // own statistic - the 1.85 baseline was computed exactly this way). ----
  const bandMeanAbs = (a, b) => winAbsMean(a, b, band.x0, band.y0, band.x1, band.y1);
  const dAL = bandMeanAbs(F.anchor, F.lift);
  const dLS = bandMeanAbs(F.lift, F.statement);
  const dAB = bandMeanAbs(F.anchor, F.bare);
  record(`A1-${face}-anchor-lift-band`, dAL >= 3.0, `compressed face-band mean luma delta ${dAL.toFixed(2)} (>= 3.0)`);
  record(`A1-${face}-lift-stmt-band`, dLS >= 3.0, `compressed face-band mean luma delta ${dLS.toFixed(2)} (>= 3.0)`);
  console.log(`    (context: anchor-bare ${dAB.toFixed(2)}; band means A ${winMean(F.anchor, band.x0, band.y0, band.x1, band.y1).toFixed(1)} L ${winMean(F.lift, band.x0, band.y0, band.x1, band.y1).toFixed(1)} S ${winMean(F.statement, band.x0, band.y0, band.x1, band.y1).toFixed(1)})`);

  // ---- A2 ----
  // Geometry is about the face-box axis (a midpoint-of-the-pair error is
  // identically zero and does not test mirroring). Alpha symmetry is the
  // 20% gate: raw luma |L-R| also counts photo shading, so it is printed
  // on the same line and not gated.
  const geo = blushGeometry(frames.statement.src);
  let geoOk = false, geoDetail = "expected 2 blush paths";
  if (geo.length === 2) {
    const [a, b] = geo[0].cx <= geo[1].cx ? geo : [geo[1], geo[0]];
    // Face-box center, not the midpoint of the two ellipses (that error is
    // identically zero for any pair and does not test the axis).
    const axis = (faceBox.x + faceBox.w / 2) * 1000;
    const mirrorErr = Math.abs((axis - a.cx) - (b.cx - axis));
    const sizeErr = Math.max(Math.abs(a.rx - b.rx), Math.abs(a.ry - b.ry));
    const heightErr = Math.abs(a.cy - b.cy);
    const sameFalloff = a.grad === b.grad;
    geoOk = mirrorErr <= 2 && sizeErr <= 1 && heightErr <= 2 && sameFalloff;
    geoDetail = `mirror err ${mirrorErr.toFixed(2)}px (<= 2) about face axis ${axis.toFixed(1)}, size err ${sizeErr.toFixed(2)}px (<= 1), height err ${heightErr.toFixed(2)}px (<= 2), shared falloff ${sameFalloff}`;
  }
  const { wins, tint } = blushWindows(frames.statement.src);
  let alphaOk = false, alphaDetail = "expected 2 cheek windows and a tint";
  if (wins.length === 2 && tint) {
    const ordered = [...wins].sort((p, q) => p.x0 - q.x0);
    const alphas = ordered.map((w) => winAlpha(R.statement, R.bare, tint, w.x0, w.y0, w.x1, w.y1));
    const dL = winAbsMean(R.statement, R.bare, ordered[0].x0, ordered[0].y0, ordered[0].x1, ordered[0].y1);
    const dR = winAbsMean(R.statement, R.bare, ordered[1].x0, ordered[1].y0, ordered[1].x1, ordered[1].y1);
    const combined = dL + dR;
    const lumaRel = combined > 0 ? Math.abs(dL - dR) / combined : 0;
    const alphaDen = Math.abs(alphas[0]) + Math.abs(alphas[1]);
    const fitOk = alphas.every((a) => Number.isFinite(a)) && alphaDen > 1e-6;
    const alphaRel = fitOk ? Math.abs(alphas[0] - alphas[1]) / alphaDen : Number.NaN;
    // |cheekL-cheekR| <= 26% of combined (L+R). Alpha is the gate; luma
    // |L-R|/(L+R) is printed because photo shading moves it run to run.
    alphaOk = fitOk && alphaRel <= 0.26;
    alphaDetail = `alpha L ${alphas[0].toFixed(3)} R ${alphas[1].toFixed(3)} rel ${fitOk ? (alphaRel * 100).toFixed(1) : "n/a"}% (<= 26); luma |L-R| ${Math.abs(dL - dR).toFixed(2)} is ${(lumaRel * 100).toFixed(1)}% of combined ${combined.toFixed(2)}`;
  }
  record(`A2-${face}-cheek-symmetry`, geoOk && alphaOk, `${geoDetail}; ${alphaDetail}`);
  if (wins.length !== 2) {
    record(`A2-${face}-no-hard-edge`, false, `expected 2 cheek windows, got ${wins.length}`);
  } else {
    const gS = wins.map((w) => winGrad(R.statement, w.x0, w.y0, w.x1, w.y1));
    const gB = wins.map((w) => winGrad(R.bare, w.x0, w.y0, w.x1, w.y1));
    const dMax = Math.max(...gS.map((g, i) => g.max - gB[i].max));
    const dP95 = Math.max(...gS.map((g, i) => g.p95 - gB[i].p95));
    record(`A2-${face}-no-hard-edge`, dMax <= 40 && dP95 <= 12, `patch h-grad over bare: max +${dMax.toFixed(1)} (<= 40), p95 +${dP95.toFixed(2)} (<= 12)`);
  }

  // ---- A4 ----
  const cheekUnion = wins.length === 2
    ? {
        x0: Math.min(...wins.map((w) => w.x0)), x1: Math.max(...wins.map((w) => w.x1)),
        y0: Math.min(...wins.map((w) => w.y0)), y1: Math.max(...wins.map((w) => w.y1)),
      }
    : { x0: band.x0, x1: band.x1, y0: band.y0 + (band.y1 - band.y0) * 0.35, y1: band.y0 + (band.y1 - band.y0) * 0.75 };
  // Under-eye: below the eye line (WFLW eye band ~ faceBox 30-42%), above
  // the cheek patches; central third of the face width.
  const undereye = { x0: band.x0 + (band.x1 - band.x0) * 0.3, x1: band.x0 + (band.x1 - band.x0) * 0.7, y0: band.y0 + (band.y1 - band.y0) * 0.42, y1: band.y0 + (band.y1 - band.y0) * 0.52 };
  for (const role of ["anchor", "lift", "statement"]) {
    for (const [rn, r] of Object.entries({ cheek: cheekUnion, undereye })) {
      const da = winAstar(R[role], r.x0, r.y0, r.x1, r.y1) - winAstar(R.bare, r.x0, r.y0, r.x1, r.y1);
      record(`A4-${face}-${role}-${rn}-warmth`, da >= -0.5, `a* delta vs bare ${da.toFixed(2)} (>= -0.5)`);
    }
  }

  // ---- A3 ----
  // First paint: first rAF sample at computed opacity >= 0.8 (the lookIn
  // fade is the only remaining delta; bitmaps decoded under the veil).
  let t80 = null;
  for (const s of fadeSamples) {
    if (s.t >= 0 && s.opacity >= 0.8) { t80 = s.t; break; }
  }
  const reached = fadeSamples.filter((s) => s.t >= 0);
  record(`A3-${face}-first-paint`, t80 !== null && t80 <= 500,
    `opacity>=0.8 at ${t80 === null ? "never" : t80.toFixed(0) + "ms"} (<= 500ms); samples ${reached.length}, first t ${reached[0]?.t.toFixed(0) ?? "?"}ms, final opacity ${reached[reached.length - 1]?.opacity ?? "?"}`);

  // Switch: first rAF sample with the strip parked on the target slide.
  let swT80 = null;
  for (const s of switchSamples) {
    if (s.t >= 0 && Math.abs(s.left - switchTarget) < 1) { swT80 = s.t; break; }
  }
  const swReached = switchSamples.filter((s) => s.t >= 0);
  record(`A3-${face}-switch-paint`, swT80 !== null && swT80 <= 500,
    `slide parked at ${swT80 === null ? "never" : swT80.toFixed(0) + "ms"} (<= 500ms); scroll clock ${swReached.length} samples, first t ${swReached[0]?.t.toFixed(0) ?? "?"}ms`);

  if (errors.length) console.log(`    console errors (${face}):`, JSON.stringify(errors.slice(0, 3)));
  await context.close();
}

await browser.close();
writeFileSync(join(OUT, "results.json"), JSON.stringify({ t: new Date().toISOString(), results }, null, 2));
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
