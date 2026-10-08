#!/usr/bin/env node
/**
 * Rendered-pixel lip colour probe.
 *
 * Drives the app the same way as demos/probe-lip-align.mjs: mock server
 * :8787, vite :5173, lip lock #b3122e. For each of the 7 faces it grabs
 * bare, anchor, lift, and statement from the real card, then measures the
 * client lip polygon minus lipInner, eroded 3 px, on those pixels.
 *
 * Gate: mean CIEDE2000 of Statement vs Lab(#b3122e) <= 4, every face's
 * L* std ratio Statement/bare >= 0.6, and Anchor < Lift < Statement in
 * dE00 distance from the bare lip. Exits non-zero on failure.
 *
 * Usage: node demos/probe-lip-color.mjs
 * Env: FACES="face-d-tan" OUT=/tmp/opl-lipcolor
 */
import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.OUT ?? "/tmp/opl-lipcolor";
mkdirSync(OUT, { recursive: true });
const FACE_PATHS = {
  "face-live": join(ROOT, "apps/client/public/fixtures/face-portrait-live.jpg"),
  "face-portrait": join(ROOT, "apps/client/public/fixtures/face-portrait.jpg"),
  "face-test": join(ROOT, "apps/server/fixtures/face-portrait-test.jpg"),
  "face-a-curly": join(ROOT, "demos/.mask-qa/faces/face-a-curly.png"),
  "face-b-pulled-back": join(ROOT, "demos/.mask-qa/faces/face-b-pulled-back.png"),
  "face-c-blonde": join(ROOT, "demos/.mask-qa/faces/face-c-blonde.png"),
  "face-d-tan": join(ROOT, "demos/.mask-qa/faces/face-d-tan.png"),
};
const REQUESTED = process.env.FACES
  ? process.env.FACES.split(",").map((s) => s.trim()).filter(Boolean)
  : null;
if (REQUESTED) {
  const unknown = REQUESTED.filter((id) => !FACE_PATHS[id]);
  if (unknown.length > 0) {
    console.error("unknown face: " + unknown.join(", "));
    process.exit(1);
  }
}
const FACES = REQUESTED ?? Object.keys(FACE_PATHS);
if (FACES.length === 0) {
  console.error("no faces");
  process.exit(1);
}
const DE_MAX = 4;
const TEXTURE_MIN = 0.6;
const ERODE = 3;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function deltaE00(L1, a1, b1, L2, a2, b2) {
  const rad = Math.PI / 180;
  const deg = 180 / Math.PI;
  const C1 = Math.hypot(a1, b1);
  const C2 = Math.hypot(a2, b2);
  const Cb = (C1 + C2) / 2;
  const Cb7 = Cb ** 7;
  const G = 0.5 * (1 - Math.sqrt(Cb7 / (Cb7 + 25 ** 7)));
  const a1p = (1 + G) * a1;
  const a2p = (1 + G) * a2;
  const C1p = Math.hypot(a1p, b1);
  const C2p = Math.hypot(a2p, b2);
  const h1 = (Math.atan2(b1, a1p) * deg + 360) % 360;
  const h2 = (Math.atan2(b2, a2p) * deg + 360) % 360;
  let dh = 0;
  if (C1p * C2p !== 0) {
    dh = h2 - h1;
    if (dh > 180) dh -= 360;
    else if (dh < -180) dh += 360;
  }
  const dL = L2 - L1;
  const dC = C2p - C1p;
  const dH = 2 * Math.sqrt(C1p * C2p) * Math.sin((dh / 2) * rad);
  const Lb = (L1 + L2) / 2;
  const Cp = (C1p + C2p) / 2;
  let hb = h1 + h2;
  if (C1p * C2p !== 0) {
    if (Math.abs(h1 - h2) <= 180) hb = (h1 + h2) / 2;
    else if (h1 + h2 < 360) hb = (h1 + h2 + 360) / 2;
    else hb = (h1 + h2 - 360) / 2;
  }
  const T = 1
    - 0.17 * Math.cos((hb - 30) * rad)
    + 0.24 * Math.cos(2 * hb * rad)
    + 0.32 * Math.cos((3 * hb + 6) * rad)
    - 0.20 * Math.cos((4 * hb - 63) * rad);
  const dTheta = 30 * Math.exp(-(((hb - 275) / 25) ** 2));
  const rc = 2 * Math.sqrt(Cp ** 7 / (Cp ** 7 + 25 ** 7));
  const Sl = 1 + (0.015 * (Lb - 50) ** 2) / Math.sqrt(20 + (Lb - 50) ** 2);
  const Sc = 1 + 0.045 * Cp;
  const Sh = 1 + 0.015 * Cp * T;
  const Rt = -Math.sin(2 * dTheta * rad) * rc;
  return Math.sqrt((dL / Sl) ** 2 + (dC / Sc) ** 2 + (dH / Sh) ** 2 + Rt * (dC / Sc) * (dH / Sh));
}

const sharma = deltaE00(50, 2.6772, -79.7751, 50, 0, -82.7485);
if (!(sharma > 2 && sharma < 2.1)) throw new Error(`deltaE00 self-check failed: ${sharma}`);

function srgbToLab(r, g, b) {
  const lin = (c) => {
    const s = c / 255;
    return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  const R = lin(r), G = lin(g), B = lin(b);
  const X = (R * 0.4124564 + G * 0.3575761 + B * 0.1804375) / 0.95047;
  const Y = R * 0.2126729 + G * 0.7151522 + B * 0.0721750;
  const Z = (R * 0.0193339 + G * 0.1191920 + B * 0.9503041) / 1.08883;
  const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
  const fx = f(X), fy = f(Y), fz = f(Z);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

const TARGET = srgbToLab(0xb3, 0x12, 0x2e);

function pointInPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i], pj = poly[j];
    if ((pi[1] > y) === (pj[1] > y)) continue;
    const xHit = ((pj[0] - pi[0]) * (y - pi[1])) / (pj[1] - pi[1]) + pi[0];
    if (x < xHit) inside = !inside;
  }
  return inside;
}

function pngSize(buf) {
  return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
}

function decodeRgb(pngPath) {
  const buf = readFileSync(pngPath);
  const { w, h } = pngSize(buf);
  const raw = pngPath.replace(/\.png$/, ".rgb");
  const r = spawnSync("ffmpeg", ["-y", "-i", pngPath, "-f", "rawvideo", "-pix_fmt", "rgb24", raw], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("decode failed " + (r.stderr ?? "").slice(-200));
  const rgb = readFileSync(raw);
  if (rgb.length !== w * h * 3) throw new Error(`rgb ${pngPath}: ${rgb.length} bytes, expected ${w * h * 3}`);
  return { rgb, w, h };
}

/** Client lip polygon minus lipInner, eroded so the feather is not in the mean. */
function lipMask(w, h, lip, lipInner) {
  const mask = new Uint8Array(w * h);
  if (!Array.isArray(lip) || lip.length < 3) return mask;
  const poly = lip.map(([x, y]) => [x * w, y * h]);
  const hole = Array.isArray(lipInner) && lipInner.length >= 3
    ? lipInner.map(([x, y]) => [x * w, y * h])
    : null;
  let minX = w, minY = h, maxX = 0, maxY = 0;
  for (const [x, y] of poly) {
    if (x < minX) minX = x;
    if (y < minY) minY = y;
    if (x > maxX) maxX = x;
    if (y > maxY) maxY = y;
  }
  const x0 = Math.max(0, Math.floor(minX));
  const y0 = Math.max(0, Math.floor(minY));
  const x1 = Math.min(w - 1, Math.ceil(maxX));
  const y1 = Math.min(h - 1, Math.ceil(maxY));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (!pointInPoly(x + 0.5, y + 0.5, poly)) continue;
      if (hole && pointInPoly(x + 0.5, y + 0.5, hole)) continue;
      mask[y * w + x] = 1;
    }
  }
  const eroded = new Uint8Array(w * h);
  for (let y = ERODE; y < h - ERODE; y++) {
    for (let x = ERODE; x < w - ERODE; x++) {
      const i = y * w + x;
      if (!mask[i]) continue;
      let keep = true;
      for (let dy = -ERODE; dy <= ERODE && keep; dy++) {
        for (let dx = -ERODE; dx <= ERODE; dx++) {
          if (!mask[(y + dy) * w + (x + dx)]) { keep = false; break; }
        }
      }
      if (keep) eroded[i] = 1;
    }
  }
  return eroded;
}

function regionLab(rgb, mask) {
  let n = 0, sL = 0, sA = 0, sB = 0, sL2 = 0;
  for (let i = 0; i < mask.length; i++) {
    if (!mask[i]) continue;
    const o = i * 3;
    const lab = srgbToLab(rgb[o], rgb[o + 1], rgb[o + 2]);
    sL += lab[0]; sA += lab[1]; sB += lab[2]; sL2 += lab[0] * lab[0];
    n += 1;
  }
  if (n < 1) return null;
  const mean = [sL / n, sA / n, sB / n];
  const stdL = Math.sqrt(Math.max(0, sL2 / n - mean[0] * mean[0]));
  return { n, mean, stdL };
}

const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json()).catch(() => null);
if (!health?.ok || health.mock !== true) throw new Error("need mock server on :8787");
if ((await fetch("http://127.0.0.1:5173").then((r) => r.status).catch(() => 0)) !== 200) {
  throw new Error("vite not up on :5173");
}

let browser;
const rows = [];
try {
  browser = await chromium.launch({ headless: true });
  for (const id of FACES) {
    const facePath = FACE_PATHS[id];
    const mime = facePath.endsWith(".png") ? "image/png" : "image/jpeg";
    const faceB64 = readFileSync(facePath).toString("base64");
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
    });
    try {
      const page = await context.newPage();
      page.setDefaultTimeout(45000);
      await page.addInitScript((faceDataUrl) => {
        let track = null;
        navigator.mediaDevices.getUserMedia = async () => {
          if (!track) {
            const img = new Image();
            img.src = faceDataUrl;
            await new Promise((resolve, reject) => {
              img.onload = () => resolve();
              img.onerror = () => reject(new Error("face image failed"));
            });
            const c = document.createElement("canvas");
            c.width = 480; c.height = 640;
            const ctx = c.getContext("2d");
            if (!ctx) throw new Error("no 2d context");
            ctx.fillStyle = "#101014";
            ctx.fillRect(0, 0, 480, 640);
            const ar = img.naturalWidth / img.naturalHeight, tar = 480 / 640;
            if (!(ar > 0) || !Number.isFinite(ar)) throw new Error("face image has no size");
            let sw = img.naturalWidth, sh = img.naturalHeight;
            if (ar > tar) sw = sh * tar; else sh = sw / tar;
            ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, 480, 640);
            track = c.captureStream(12).getVideoTracks()[0];
          }
          return new MediaStream([track.clone()]);
        };
      }, `data:${mime};base64,` + faceB64);
      let sentLm = null;
      await page.route("**/api/session/*/face", async (route) => {
        const raw = route.request().postData();
        if (!raw) throw new Error(`${id}: face post had no body`);
        const body = JSON.parse(raw);
        if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error(`${id}: face post was not an object`);
        body.lock = { category: "lip", onFaceHex: "#b3122e", productHex: "#c01830", unverified: false };
        sentLm = body.landmarks ?? null;
        await route.continue({ postData: JSON.stringify(body) });
      });
      await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
      await page.waitForSelector(".shutter:not([disabled])");
      await sleep(1200);
      await page.click(".shutter");
      await page.waitForSelector(".lock-ring");
      await page.waitForFunction(() => {
        const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
        return b && !b.disabled;
      }, null, { timeout: 60000 });
      await sleep(400);
      await page.click("text=/See my three looks/i");
      await page.waitForSelector(".look-frame img:not(.bare-img)");
      await sleep(2500);
      const dump = await page.evaluate(() => {
        const grab = (sel) => {
          const img = document.querySelector(sel);
          if (!img || !img.naturalWidth || !img.naturalHeight) return null;
          const c = document.createElement("canvas");
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext("2d");
          if (!ctx) return null;
          ctx.drawImage(img, 0, 0);
          return c.toDataURL("image/png");
        };
        return {
          bare: grab(".look-slide:nth-child(1) .bare-img"),
          anchor: grab(".look-slide:nth-child(1) img:not(.bare-img)"),
          lift: grab(".look-slide:nth-child(2) img:not(.bare-img)"),
          statement: grab(".look-slide:nth-child(3) img:not(.bare-img)"),
        };
      });
      const frames = {};
      for (const name of ["bare", "anchor", "lift", "statement"]) {
        const url = dump[name];
        if (!url || !url.includes(",")) throw new Error(`${id}: missing ${name}`);
        const png = join(OUT, `${id}-${name}.png`);
        writeFileSync(png, Buffer.from(url.split(",")[1], "base64"));
        frames[name] = decodeRgb(png);
      }
      const lip = sentLm?.lip;
      const lipInner = sentLm?.lipInner;
      if (!Array.isArray(lip) || lip.length < 3) throw new Error(`${id}: landmarks had no lip`);
      const { w, h } = frames.bare;
      if (!(w >= 32 && h >= 32)) throw new Error(`${id}: frame ${w}x${h}`);
      for (const name of ["anchor", "lift", "statement"]) {
        if (frames[name].w !== w || frames[name].h !== h) {
          throw new Error(`${id}: ${name} is ${frames[name].w}x${frames[name].h}, bare is ${w}x${h}`);
        }
      }
      const mask = lipMask(w, h, lip, lipInner);
      let px = 0;
      for (let i = 0; i < mask.length; i++) if (mask[i]) px += 1;
      if (px < 20) throw new Error(`${id}: lip interior ${px}px after erode`);
      const stats = {};
      for (const name of ["bare", "anchor", "lift", "statement"]) {
        const lab = regionLab(frames[name].rgb, mask);
        if (!lab || !lab.mean.every((v) => Number.isFinite(v)) || !Number.isFinite(lab.stdL)) {
          throw new Error(`${id}: no Lab for ${name}`);
        }
        stats[name] = lab;
      }
      const stmt = stats.statement.mean;
      const bare = stats.bare.mean;
      const hue = (v) => (Math.atan2(v[2], v[1]) * 180 / Math.PI + 360) % 360;
      const stdRatio = stats.statement.stdL / Math.max(1e-6, stats.bare.stdL);
      const ramp = ["anchor", "lift", "statement"].map((name) =>
        deltaE00(bare[0], bare[1], bare[2], stats[name].mean[0], stats[name].mean[1], stats[name].mean[2]));
      if (!Number.isFinite(stdRatio) || !ramp.every((v) => Number.isFinite(v))) {
        throw new Error(`${id}: colour stats not finite`);
      }
      const row = {
        face: id,
        px,
        hole: Array.isArray(lipInner) && lipInner.length >= 3,
        bare: bare.map((v) => Number(v.toFixed(1))),
        statement: stmt.map((v) => Number(v.toFixed(1))),
        de00: Number(deltaE00(stmt[0], stmt[1], stmt[2], TARGET[0], TARGET[1], TARGET[2]).toFixed(2)),
        hue: Number(hue(stmt).toFixed(1)),
        targetHue: Number(hue(TARGET).toFixed(1)),
        stdRatio: Number(stdRatio.toFixed(3)),
        rampDe00: ramp.map((v) => Number(v.toFixed(2))),
      };
      if (!Number.isFinite(row.de00)) throw new Error(`${id}: dE00 not finite`);
      rows.push(row);
      console.log(`${id}: Lab (${row.statement.join(", ")}) dE00 ${row.de00} texture ${row.stdRatio} ramp ${row.rampDe00.join("/")}`);
    } finally {
      await context.close();
    }
  }
} catch (err) {
  writeFileSync(join(OUT, "results.json"), JSON.stringify({
    t: new Date().toISOString(),
    pass: false,
    error: err instanceof Error ? err.message : String(err),
    faces: rows,
  }, null, 2));
  throw err;
} finally {
  await browser?.close();
}

const meanDe = rows.reduce((s, r) => s + r.de00, 0) / Math.max(1, rows.length);
const textureOk = rows.length > 0 && rows.every((r) => r.stdRatio >= TEXTURE_MIN);
const rampOk = rows.length > 0 && rows.every((r) => r.rampDe00[0] < r.rampDe00[1] && r.rampDe00[1] < r.rampDe00[2]);
const pass = rows.length === FACES.length && meanDe <= DE_MAX && textureOk && rampOk;
const summary = {
  t: new Date().toISOString(),
  targetLab: TARGET.map((v) => Number(v.toFixed(2))),
  meanDe00: Number(meanDe.toFixed(2)),
  deMax: DE_MAX,
  textureMin: TEXTURE_MIN,
  pass,
  faces: rows,
};
writeFileSync(join(OUT, "results.json"), JSON.stringify(summary, null, 2));
const header = "| face | lip px | hole | bare mean Lab | Statement mean Lab | dE00 vs #b3122e | hue stmt / target | L std stmt/bare | dE00 to bare A/L/S |";
const rule = "|---|---|---|---|---|---|---|---|---|";
const lines = [header, rule];
for (const r of rows) {
  lines.push(`| ${r.face} | ${r.px} | ${r.hole ? "yes" : "no"} | (${r.bare.join(", ")}) | (${r.statement.join(", ")}) | ${r.de00} | ${r.hue} / ${r.targetHue} | ${r.stdRatio} | ${r.rampDe00.join(" / ")} |`);
}
lines.push("");
lines.push(`mean dE00 ${summary.meanDe00} (gate <= ${DE_MAX}), texture >= ${TEXTURE_MIN}: ${textureOk ? "yes" : "no"}, ramp: ${rampOk ? "yes" : "no"}, ${pass ? "PASS" : "FAIL"}`);
const md = lines.join("\n") + "\n";
writeFileSync(join(OUT, "results.md"), md);
console.log(md);
console.log(pass ? "PASS" : "FAIL", "->", OUT);
if (!pass) process.exit(1);
