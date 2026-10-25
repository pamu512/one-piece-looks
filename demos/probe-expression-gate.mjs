#!/usr/bin/env node
/**
 * Expression-gate probe (plan phase 2 step 4, 2026-10-25): an open mouth
 * or a big smile must fade the face map's mouth-adjacent pigment instead
 * of painting across the hole.
 *
 * Drives the real client headlessly (fake-camera face, mock server behind
 * vite) three times through to the face map sheet:
 *
 *   open + ?exprgate=0   the synthetic open-mouth fixture with the gate
 *                        disabled - the ungated baseline look.
 *   open (default)       same fixture, gate on. The svg's data-expr carries
 *                        the live signals (lip-part ratio, jawOpen,
 *                        mouthSmile) and every pigment polygon a data-gain.
 *   closed (default)     the stock blonde fixture - the control: a neutral
 *                        closed mouth must keep full pigment (gain 1).
 *
 * Gates:
 *   signals-live  the open fixture reaches the face map and its measured
 *                 signals read clearly open: lip >= 0.30, jaw >= 0.35.
 *   gains-fade    every gated zone painted on the open face carries a
 *                 gain < 1, and the strongest fade (cheek or lip class)
 *                 is <= 0.40.
 *   pigment-fade  on the biggest cheek zone, mean |dRGB| vs the bare photo
 *                 drops to <= 45% of the ungated build's value - the fade
 *                 is visible in pixels, not just attributes.
 *   closed-keep   on the closed face every painted gated zone keeps gain
 *                 1.000 and the cheek pigment is still present (|dRGB|
 *                 >= 4): no over-gating of neutral faces.
 *
 * Writes OUT/{open-gated,open-ungated,closed}.png, OUT/side-by-side.png,
 * and OUT/results.json. GATE=1 exits nonzero when a gate fails.
 *
 * The open fixture (face-e-open-mouth.png, local like every .mask-qa face -
 * that dir is gitignored) is synthetic: no open-mouth frontal footage exists
 * in the repo (scored: stock-head-turn clips and beauty-cam recordings stay
 * closed or yaw-gate). Recipe: 4:5 center-crop of face-c-blonde.png, then a
 * jaw-drop shear - rows below the lip line slide down 18% of face height
 * over a 20px ramp - a blurred dark ellipse between the lips, and a
 * white-ish teeth arc at its top. It exercises the full real path: the same
 * FaceLandmarker that serves users produces the mesh, the blendshapes, and
 * thus the gate.
 *
 * Usage: node demos/probe-expression-gate.mjs
 * Needs: mock server :8787, vite :5173 (same stack pixel-gates.sh boots),
 * and demos/.mask-qa/faces/{face-e-open-mouth,face-c-blonde}.png.
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const ROOT = join(import.meta.dirname, "..");
const OUT = process.env.OUT ?? "/tmp/opl-expr-gate";
const BASE = "http://127.0.0.1:5173";
const OPEN_FACE = process.env.OPEN_FACE
  ? join(ROOT, process.env.OPEN_FACE)
  : join(ROOT, "demos/.mask-qa/faces/face-e-open-mouth.png");
const CLOSED_FACE = process.env.CLOSED_FACE
  ? join(ROOT, process.env.CLOSED_FACE)
  : join(ROOT, "demos/.mask-qa/faces/face-c-blonde.png");
const GATE = process.env.GATE === "1";
mkdirSync(OUT, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = { url: BASE, openFace: OPEN_FACE, closedFace: CLOSED_FACE, runs: {}, gate: GATE, pass: [] };
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

/** Mean |dRGB| (filled vs bare) over a disc core. */
function coreDelta(filled, bare, cx, cy, r) {
  let dr = 0, n = 0;
  for (let y = cy - r; y <= cy + r; y += 2) for (let x = cx - r; x <= cx + r; x += 2) {
    if (Math.hypot(x - cx, y - cy) > r) continue;
    const i = ((y | 0) * filled.w + (x | 0)) * 3;
    dr += Math.abs(filled.rgb[i] - bare.rgb[i])
      + Math.abs(filled.rgb[i + 1] - bare.rgb[i + 1])
      + Math.abs(filled.rgb[i + 2] - bare.rgb[i + 2]);
    n++;
  }
  return n ? dr / (3 * n) : 0;
}

const browser = await chromium.launch({ headless: true });

/** One driven session: fake-camera context on `face`, through to the open face map. */
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

/** The svg's data-expr signals + per-zone gains + filled polygon geometry. */
async function mapState(p) {
  return p.$eval(".coach-map svg", (svg) => {
    const rect = svg.getBoundingClientRect();
    const dsf = window.devicePixelRatio || 1;
    const zones = {};
    for (const el of svg.querySelectorAll("polygon[data-zone]")) {
      if (el.getAttribute("fill") === "none") continue;
      const id = el.getAttribute("data-zone");
      zones[id] = {
        gain: Number(el.getAttribute("data-gain") ?? "1"),
        opacity: Number(el.getAttribute("fill-opacity") ?? "0"),
        cx: 0, cy: 0, rw: 0,
      };
    }
    for (const el of svg.querySelectorAll("polygon[data-zone]")) {
      if (el.getAttribute("fill") === "none") continue;
      const id = el.getAttribute("data-zone");
      const pts = (el.getAttribute("points") || "").trim().split(/\s+/).map((pair) => {
        const [x, y] = pair.split(",").map(Number);
        return { x: (x / 1000) * rect.width * dsf, y: (y / 1250) * rect.height * dsf };
      });
      const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
      const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
      zones[id].cx = cx;
      zones[id].cy = cy;
      zones[id].rw = Math.min(...pts.map((q) => Math.hypot(q.x - cx, q.y - cy)));
    }
    return { expr: svg.getAttribute("data-expr"), shape: document.querySelector(".shape-word")?.textContent?.trim() ?? null, zones };
  });
}

/** Pigment |dRGB| for one zone: filled shot vs polygons-hidden bare shot. */
async function zoneDelta(p, zone, tag) {
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((q) => {
      if (q.getAttribute("fill") === "none") q.style.visibility = "hidden";
    });
  });
  const filled = await shot(p, join(OUT, `${tag}.png`));
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((q) => { q.style.visibility = "hidden"; });
  });
  const bare = await shot(p, join(OUT, `${tag}-bare.png`));
  await p.evaluate(() => {
    document.querySelectorAll(".coach-map svg polygon").forEach((q) => { q.style.visibility = ""; });
  });
  return coreDelta(filled, bare, zone.cx, zone.cy, Math.max(4, zone.rw * 0.5));
}

async function shot(p, path) {
  await p.locator(".coach-map svg").screenshot({ path });
  return planes(path);
}

/**
 * Focus the warm (blush) chip so the cheek measurement matches
 * probe-soft-fills' blush calibration: single-step opacity, the |dRGB| >= 4
 * visibility floor was measured on exactly this view of this face.
 */
async function focusWarm(p) {
  const chip = p.locator(".coach-steps .chip-vibe", { hasText: /warm/i }).first();
  if (await chip.count()) {
    await chip.click();
    await sleep(500);
    return await mapState(p);
  }
  return null;
}

function parseExpr(expr) {
  const out = {};
  for (const kv of (expr ?? "").split(",")) {
    const [k, v] = kv.split(":");
    out[k] = v === "-" || v === undefined ? null : Number(v);
  }
  return out;
}

/** Gated zone classes mirrored from lib/coach/expressionGate.ts (probe-side copy). */
const GATED = new Set([
  "cupid_bow", "chin_ball", "under_chin", "cheek_shelf_L", "cheek_shelf_R",
  "jaw_L", "jaw_R", "cheek_apple_L", "cheek_apple_R", "cheek_tip_L", "cheek_tip_R",
]);

// ---- run 1: open fixture, gate off (baseline) ----
const openB64 = readFileSync(OPEN_FACE).toString("base64");
const pOff = await drive(`${BASE}/?exprgate=0`, openB64);
const off = await mapState(pOff);
results.runs.openUngated = off;
console.log(`INFO  open-ungated  shape=${off.shape ?? "?"} expr=${off.expr} zones=${Object.keys(off.zones).join(",")}`);

// ---- run 2: open fixture, gate on ----
const pOn = await drive(BASE, openB64);
const on = await mapState(pOn);
results.runs.openGated = on;
const sig = parseExpr(on.expr);
console.log(`INFO  open-gated  shape=${on.shape ?? "?"} expr=${on.expr} gains=${Object.entries(on.zones).map(([z, v]) => `${z}:${v.gain}`).join(" ")}`);

// ---- run 3: closed fixture, gate on (control) ----
const closedB64 = readFileSync(CLOSED_FACE).toString("base64");
const pClosed = await drive(BASE, closedB64);
const closed = await mapState(pClosed);
results.runs.closed = closed;
const csig = parseExpr(closed.expr);
console.log(`INFO  closed  shape=${closed.shape ?? "?"} expr=${closed.expr} gains=${Object.entries(closed.zones).map(([z, v]) => `${z}:${v.gain}`).join(" ")}`);

await pOn.screenshot({ path: join(OUT, "coach-sheet-open.png") });

// ---- gates ----
const reachedMap = on.expr !== null && on.expr !== "off" && sig.lip !== null;
record("signals-live", reachedMap && sig.lip >= 0.3 && (sig.jaw ?? 0) >= 0.35,
  `open fixture signals through the real path: lip=${sig.lip} jaw=${sig.jaw} smile=${sig.smile}`);

const gatedZones = Object.entries(on.zones).filter(([z]) => GATED.has(z));
const gains = gatedZones.map(([, v]) => v.gain);
record("gains-fade", gatedZones.length > 0 && gains.every((g) => g < 1) && Math.min(...gains) <= 0.4,
  `${gatedZones.length} gated zones painted, gains [${gains.map((g) => g.toFixed(3)).join(", ")}]`);

const cheek = on.zones.cheek_apple_L ?? on.zones.cheek_apple_R ?? null;
const cheekOff = off.zones.cheek_apple_L ?? off.zones.cheek_apple_R ?? null;
let fadeRatio = null;
if (cheek && cheekOff) {
  const onWarm = await focusWarm(pOn);
  const offWarm = await focusWarm(pOff);
  const zoneOn = (onWarm ?? on).zones.cheek_apple_L ?? (onWarm ?? on).zones.cheek_apple_R ?? cheek;
  const zoneOff = (offWarm ?? off).zones.cheek_apple_L ?? (offWarm ?? off).zones.cheek_apple_R ?? cheekOff;
  const dOn = await zoneDelta(pOn, zoneOn, "open-gated");
  const dOff = await zoneDelta(pOff, zoneOff, "open-ungated");
  fadeRatio = dOn / (dOff || 1);
  results.cheekPigment = { gated: +dOn.toFixed(2), ungated: +dOff.toFixed(2), ratio: +fadeRatio.toFixed(3) };
  console.log(`INFO  pigment-fade  cheek |dRGB| gated=${dOn.toFixed(2)} ungated=${dOff.toFixed(2)} ratio=${fadeRatio.toFixed(3)}`);
}
record("pigment-fade", cheek && cheekOff && fadeRatio !== null && fadeRatio <= 0.45 && fadeRatio >= 0,
  `cheek pigment drops to ${fadeRatio === null ? "?" : (fadeRatio * 100).toFixed(0)}% of ungated on the open mouth`);

const closedGated = Object.entries(closed.zones).filter(([z]) => GATED.has(z));
let closedKeep = false;
let closedDetail = "";
if (closedGated.length > 0) {
  const allFull = closedGated.every(([, v]) => v.gain === 1);
  const closedWarm = await focusWarm(pClosed);
  const cheekClosed = closedWarm?.zones.cheek_apple_L ?? closedWarm?.zones.cheek_apple_R
    ?? closed.zones.cheek_apple_L ?? closed.zones.cheek_apple_R ?? null;
  const dClosed = cheekClosed ? await zoneDelta(pClosed, cheekClosed, "closed") : null;
  closedKeep = allFull && dClosed !== null && dClosed >= 4;
  closedDetail = `gains all ${allFull ? "1.000" : "NOT 1"}, warm-chip cheek |dRGB|=${dClosed?.toFixed(2) ?? "?"} (sig lip=${csig.lip} jaw=${csig.jaw} smile=${csig.smile})`;
} else {
  closedDetail = "no gated zones painted on the control face";
}
record("closed-keep", closedKeep, closedDetail);

// ---- side-by-side artifact ----
spawnSync("ffmpeg", ["-y", "-i", join(OUT, "open-ungated.png"), "-i", join(OUT, "open-gated.png"), "-i", join(OUT, "closed.png"),
  "-filter_complex", "[0][1][2]hstack=3", join(OUT, "side-by-side.png")], { encoding: "utf8" });

writeFileSync(join(OUT, "results.json"), JSON.stringify(results, null, 2));
console.log(`INFO  artifacts  ${OUT}/side-by-side.png + results.json`);

const failed = results.pass.filter((r) => !r.pass).length;
console.log(failed === 0 ? "ALL GATES PASS" : `${failed} GATE(S) FAILED`);
process.exit(GATE && failed > 0 ? 1 : 0);
