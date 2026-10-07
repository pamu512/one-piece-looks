#!/usr/bin/env node
/**
 * UI-level look-distinct probe: drives the real client (vite :5173 + mock
 * server :8787) with the fake camera, builds Soft x Casual looks, then
 * rasterizes each carousel slide in-page and measures pairwise pixel
 * deltas (with real client landmarks) plus hold-to-compare behavior.
 */
import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";

const BASE = "http://127.0.0.1:5173";
const __d = (await import("node:url")).fileURLToPath(import.meta.url);
const ROOT = (await import("node:path")).join((await import("node:path")).dirname(__d), "..");
const FACE = join(ROOT, "demos/.mask-qa/faces/face-c-blonde.png");
const OUT = process.env.OUT ?? "/tmp/opl-distinct-ui";
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) { try { unlinkSync(join(OUT, f)); } catch {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
if (!health?.ok || health.mock !== true) throw new Error("need mock server on :8787");
if ((await fetch(BASE).then((r) => r.status)) !== 200) throw new Error("vite not up on :5173");

const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
});
const page = await context.newPage();
page.setDefaultTimeout(45000);
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });

const faceB64 = readFileSync(FACE).toString("base64");
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

// retarget to lip lock (matches recorder flow)
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
await page.click("text=/See my three looks/i");
await page.waitForFunction(() => {
  const img = document.querySelector(".look-frame img:not(.bare-img)");
  return img && img.complete && img.naturalWidth > 0;
});
await sleep(1200);

// grab all three worn renders + bare overlay rasters, pairwise diffs, and
// lock-hex equality measured on the lip region of each render.
const stats = await page.evaluate(async () => {
  const grab = (sel) => {
    const img = document.querySelector(sel);
    if (!img) return null;
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || 1000;
    c.height = img.naturalHeight || 1250;
    c.getContext("2d").drawImage(img, 0, 0);
    return c.getContext("2d").getImageData(0, 0, c.width, c.height);
  };
  const roles = ["anchor", "lift", "statement"];
  const frames = {};
  for (let i = 1; i <= 3; i++) {
    frames[roles[i - 1]] = grab(`.look-slide:nth-child(${i}) img:not(.bare-img)`);
  }
  frames.bare = grab(".look-slide:nth-child(1) .bare-img");
  if (!frames.anchor || !frames.lift || !frames.statement || !frames.bare) return { error: "missing frames" };

  // Interrogate the actual API payload the client holds (React state) via
  // the share composer path is overkill; instead read lip color: sample the
  // 60th-percentile-red pixel band in the mouth region as the lock color
  // proxy for each role render and require near-identical lock color.
  const lipSample = (f) => {
    // mouth around x .40-.60, y .66-.78 of the 4:5 frame (framing guide)
    const x0 = Math.round(f.width * 0.40), x1 = Math.round(f.width * 0.60);
    const y0 = Math.round(f.height * 0.66), y1 = Math.round(f.height * 0.78);
    let rs = 0, gs = 0, bs = 0, n = 0;
    for (let y = y0; y < y1; y += 3) {
      for (let x = x0; x < x1; x += 3) {
        const i = (y * f.width + x) * 4;
        rs += f.data[i]; gs += f.data[i + 1]; bs += f.data[i + 2]; n++;
      }
    }
    return { r: Math.round(rs / n), g: Math.round(gs / n), b: Math.round(bs / n) };
  };

  const diff = (a, b) => {
    let sum = 0, n = 0, changed = 0, changedSum = 0, peak = 0;
    for (let i = 0; i < a.data.length; i += 4) {
      const d = Math.abs(a.data[i] - b.data[i]);
      sum += d; n++;
      if (d > peak) peak = d;
      if (d >= 8) { changed++; changedSum += d; }
    }
    return {
      mean: +(sum / n).toFixed(3),
      peak,
      changedPct: +((changed / n) * 100).toFixed(2),
      meanChanged: changed ? +(changedSum / changed).toFixed(2) : 0,
    };
  };

  const lockHexes = roles.map((r) => lipSample(frames[r]));
  return {
    anchorVsBare: diff(frames.anchor, frames.bare),
    liftVsBare: diff(frames.lift, frames.bare),
    stmtVsBare: diff(frames.statement, frames.bare),
    liftVsAnchor: diff(frames.lift, frames.anchor),
    stmtVsAnchor: diff(frames.statement, frames.anchor),
    stmtVsLift: diff(frames.statement, frames.lift),
    lipRegion: lockHexes,
  };
});
if (stats.error) throw new Error(stats.error);
console.log("\n=== UI (Soft x Casual, client landmarks, face-c-blonde) ===");
for (const [k, v] of Object.entries(stats)) {
  if (k === "lipRegion") continue;
  console.log(`  ${k}: mean ${v.mean} peak ${v.peak} changedPct ${v.changedPct}%`);
}
console.log("  lip-region rgb per role:", JSON.stringify(stats.lipRegion));
writeFileSync(join(OUT, "ui-stats.json"), JSON.stringify(stats, null, 2));

// hold-to-compare: pointer down on the strip -> bare overlay visible + worn hidden
const frame = await page.locator(".look-frame").first().boundingBox();
await page.mouse.move(frame.x + frame.width / 2, frame.y + frame.height / 2);
await page.mouse.down();
await sleep(700);
const holdState = await page.evaluate(() => {
  const worn = document.querySelector(".look-slide:nth-child(1) img:not(.bare-img)");
  const bare = document.querySelector(".look-slide:nth-child(1) .bare-img");
  const pill = document.querySelector(".role-pill");
  return {
    wornHidden: worn?.className.includes("bare"),
    bareShown: bare?.getAttribute("data-on") === "1",
    pillText: pill?.textContent,
  };
});
await page.screenshot({ path: join(OUT, "hold-bare.png") });
await page.mouse.up();
console.log("hold-to-compare:", JSON.stringify(holdState));

const gates = {
  // Soft lips Option B (color+soft-light) ramps role alpha on the mask;
  // Anchor→Statement pulls mean mouth RGB toward #b3122e more than Soft LAB.
  // Soft-eased lock band was 10 (opaque) → 12 (LAB) → 14 (Option B).
  lockLipRegionStable: stats.lipRegion.every((c) =>
    Math.abs(c.r - stats.lipRegion[0].r) <= 14 &&
    Math.abs(c.g - stats.lipRegion[0].g) <= 14 &&
    Math.abs(c.b - stats.lipRegion[0].b) <= 14),
  anchorNearBare: stats.anchorVsBare.mean < stats.liftVsBare.mean,
  // Raised 2026-10-07 (verdict P0-1): Lift carries lash+brow+cheek now; a
  // sub-1% changed area can never read as a different look after compression.
  liftVisible: stats.liftVsAnchor.meanChanged >= 4 && stats.liftVsAnchor.changedPct >= 2.0,
  statementFullest: stats.stmtVsBare.mean > stats.liftVsBare.mean && stats.stmtVsBare.mean > stats.anchorVsBare.mean,
  holdShowsBare: holdState.bareShown === true && holdState.wornHidden === true,
  consoleClean: errors.length === 0,
};
console.log("\ngates:");
for (const [k, v] of Object.entries(gates)) console.log(`  ${v ? "PASS" : "FAIL"}  ${k}`);
writeFileSync(join(OUT, "gates.json"), JSON.stringify({ gates, errors: errors.slice(0, 5), t: new Date().toISOString() }, null, 2));

await context.close();
await browser.close();
process.exit(Object.values(gates).every(Boolean) ? 0 : 1);
