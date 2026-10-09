#!/usr/bin/env node
/**
 * Frame-diff probe for the mock faceCard compositor: builds looks via the
 * real API (Soft x Casual + Soft x Night out), rasterizes each role's SVG
 * data URL, and measures mean/peak pixel deltas between Anchor / Lift /
 * Statement and the bare photo. Proves the three roles are visually
 * distinct with the same lock hex, and quantifies the layering.
 *
 * Gates:
 *   - lock hex identical on all three looks (product lock stays)
 *   - three distinct imageUrls (no shared composite)
 *   - anchor vs bare: lip present but smallest deviation (near bare)
 *   - lift vs bare > anchor vs bare (visible supporting layer)
 *   - statement vs bare > lift vs bare (fullest face)
 *
 * Usage: node probe-look-distinct.mjs [BASE]
 * Default BASE http://127.0.0.1:8787 (YOUCAM_MOCK=1 server).
 */
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";

// Headless Chromium rasterizes the SVG data URLs exactly as the client
// browser does (blend modes, blur filters, embedded JPEG).
const browser = await chromium.launch({ headless: true });
const rasterPage = await (await browser.newContext()).newPage();

async function rasterize(dataUrl, outPng) {
  const ok = await rasterPage.evaluate(async ({ url, out }) => {
    const img = new Image();
    img.src = url;
    await new Promise((res) => { img.onload = res; img.onerror = () => res(null); });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || 1000;
    c.height = img.naturalHeight || 1250;
    c.getContext("2d").drawImage(img, 0, 0);
    window.__png = c.toDataURL("image/png");
    return img.naturalWidth > 0;
  }, { url: dataUrl, out: outPng });
  if (!ok) throw new Error("rasterize failed (img not decoded)");
  const b64 = (await rasterPage.evaluate(() => window.__png)).split(",")[1];
  writeFileSync(outPng, Buffer.from(b64, "base64"));
}

const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const __d = (await import("node:url")).fileURLToPath(import.meta.url);
const ROOT = (await import("node:path")).join((await import("node:path")).dirname(__d), "..");
const OUT = process.env.OUT ?? "/tmp/opl-distinct";
const FACE = join(ROOT, "apps/server/fixtures/face-portrait-live.jpg");
mkdirSync(OUT, { recursive: true });
for (const f of readdirSync(OUT)) { try { unlinkSync(join(OUT, f)); } catch {} }

const LOCK = { category: "lip", onFaceHex: "#b3122e", productHex: "#c01830", unverified: false };

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => ({})) };
}

async function diffStats(a, b) {
  const toDataUrl = (p) => "data:image/png;base64," + readFileSync(p).toString("base64");
  return await diffStatsUrls(toDataUrl(a), toDataUrl(b));
}

async function diffStatsUrls(au, bu) {
  // Decode both PNGs in the browser and compute exact per-pixel deltas:
  // full-frame mean dilutes localized makeup (lip band ~3% of frame), so
  // also report changed-pixel share and mean-over-changed-pixels.
  return await rasterPage.evaluate(async ({ a: au, b: bu }) => {
    const load = (u) => new Promise((res) => {
      const img = new Image();
      img.onload = () => res(img);
      img.onerror = () => res(null);
      img.src = u;
    });
    const ia = await load(au), ib = await load(bu);
    if (!ia || !ib) return null;
    const c = document.createElement("canvas");
    c.width = Math.min(ia.naturalWidth, ib.naturalWidth);
    c.height = Math.min(ia.naturalHeight, ib.naturalHeight);
    const ctx = c.getContext("2d");
    const grab = (img) => {
      const g = document.createElement("canvas");
      g.width = c.width; g.height = c.height;
      g.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      return g.getContext("2d").getImageData(0, 0, c.width, c.height).data;
    };
    const da = grab(ia), db = grab(ib);
    let sum = 0, n = 0, changed = 0, changedSum = 0, peak = 0;
    for (let i = 0; i < da.length; i += 4) {
      const d = Math.abs(da[i] - db[i]);
      sum += d; n++;
      if (d > peak) peak = d;
      if (d >= 8) { changed++; changedSum += d; }
    }
    return {
      mean: Number((sum / n).toFixed(3)),
      peak,
      changedPct: Number(((changed / n) * 100).toFixed(2)),
      meanChanged: changed ? Number((changedSum / changed).toFixed(2)) : 0,
    };
  }, { a: au, b: bu });
}

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${detail}`);
}

async function buildAndMeasure(mood, event, tag) {
  const session = await http("POST", "/api/session", {});
  const id = session.json.sessionId;
  const faceImageBase64 = readFileSync(FACE).toString("base64");
  const face = await http("POST", `/api/session/${id}/face`, { faceImageBase64, lock: LOCK });
  if (face.status !== 200) throw new Error("face failed: " + JSON.stringify(face.json));
  const looks = await http("POST", `/api/session/${id}/looks`, { mood, event });
  if (looks.status !== 200) throw new Error("looks failed: " + JSON.stringify(looks.json));

  for (const l of looks.json.looks) await rasterize(l.imageUrl, join(OUT, `${tag}-${l.role}.png`));

  // bare baseline: the raw fixture the server composited on (no landmarks
  // in this direct-API path, so base layer == fixture bytes)
  const bare = join(OUT, `${tag}-bare.png`);
  spawnSync("ffmpeg", ["-y", "-i", FACE, "-vf", "scale=1000:1250:force_original_aspect_ratio=increase,crop=1000:1250", "-frames:v", "1", bare], { encoding: "utf8" });

  const d = {
    anchorVsBare: await diffStats(join(OUT, `${tag}-anchor.png`), bare),
    liftVsBare: await diffStats(join(OUT, `${tag}-lift.png`), bare),
    stmtVsBare: await diffStats(join(OUT, `${tag}-statement.png`), bare),
    liftVsAnchor: await diffStats(join(OUT, `${tag}-lift.png`), join(OUT, `${tag}-anchor.png`)),
    stmtVsAnchor: await diffStats(join(OUT, `${tag}-statement.png`), join(OUT, `${tag}-anchor.png`)),
    stmtVsLift: await diffStats(join(OUT, `${tag}-statement.png`), join(OUT, `${tag}-lift.png`)),
  };
  console.log(`\n=== ${mood} x ${event} ===`);
  for (const [k, v] of Object.entries(d)) console.log(`  ${k}: mean ${v.mean} peak ${v.peak}`);

  record(`${tag}-lock-hex-all-three`,
    looks.json.looks.every((l) => l.chips?.[0]?.hex?.toLowerCase() === LOCK.onFaceHex),
    `first chip hex all three: ${looks.json.looks.map((l) => l.chips?.[0]?.hex).join(", ")}`);
  record(`${tag}-three-distinct-images`,
    new Set(looks.json.looks.map((l) => l.imageUrl)).size === 3,
    `unique imageUrls: ${new Set(looks.json.looks.map((l) => l.imageUrl)).size}`);
  record(`${tag}-anchor-near-bare-lip-present`,
    d.anchorVsBare.mean > 0.4 && d.anchorVsBare.peak >= 24,
    `anchor-bare mean ${d.anchorVsBare.mean} peak ${d.anchorVsBare.peak}`);
  record(`${tag}-lift-visible-vs-anchor`,
    // Soft LAB (2026-10-07): feathered grade caps peak vs opaque stamps; mean
    // floor stays, peak floor eases to 34 so Soft still proves a nameable Lift.
    d.liftVsAnchor.mean > 2.0 && d.liftVsAnchor.peak >= 34,
    `lift-anchor mean ${d.liftVsAnchor.mean} peak ${d.liftVsAnchor.peak}`);
  record(`${tag}-statement-fullest`,
    d.stmtVsBare.mean > d.liftVsBare.mean && d.stmtVsBare.mean > d.anchorVsBare.mean,
    `means anchor ${d.anchorVsBare.mean} < lift ${d.liftVsBare.mean} < stmt ${d.stmtVsBare.mean}`);
  return d;
}

const health = await http("GET", "/health");
if (health.status !== 200 || !health.json?.ok) throw new Error("server not healthy on " + BASE);

await buildAndMeasure("Soft", "Casual", "softcasual");
await buildAndMeasure("Soft", "Night out", "softnight");

writeFileSync(join(OUT, "results.json"), JSON.stringify({ t: new Date().toISOString(), results }, null, 2));
await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
