#!/usr/bin/env node
/**
 * Pin-the-indices probe (FACE-GEOMETRY.md section 7.1).
 *
 * Renders the numbered 478-pt mesh dots + the proposed zone/ribbon catalog
 * over apps/client/public/fixtures/face-portrait.jpg using the REAL wasm
 * landmarker (same model + wasm the app ships), then writes
 * demos/landmarks/face-portrait-overview.png.
 *
 * Reuses the probe pattern of demos/probe-lip-align.mjs: a headless
 * chromium page runs the landmarker; ffmpeg decodes the fixture to raw
 * rgb; drawing happens on the page canvas; the PNG lands via toDataURL.
 * No server needed - the wasm/model files are fulfilled from disk.
 *
 * Numbers printed beside the dots are the raw landmark indices so the
 * pinned tables in coach/measure.ts, coach/zones.ts and
 * docs/FACE-GEOMETRY.md can be eyeballed and corrected in one pass.
 * Highlighted dots (index label always shown): the measurement anchors
 * (10, 152, 127, 356, 172, 397, 103, 332, 61, 291, 33, 263, 4, 234, 454),
 * the zone anchors, and the ribbon centerlines.
 *
 * Usage: node demos/render-landmarks.mjs
 * Env: FACE=<path-to-jpg> (default: the portrait fixture) OUT=<dir>
 * Needs: playwright at /tmp/opl-pw (repo probe convention), ffmpeg on PATH
 *        or at the repo-pinned tools path.
 */

import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { homedir, tmpdir } from "node:os";

const ROOT = join(import.meta.dirname, "..");
const FACE = process.env.FACE ?? join(ROOT, "apps/client/public/fixtures/face-portrait.jpg");
const OUT_DIR = process.env.OUT ?? join(ROOT, "demos/landmarks");
const W = 500, H = 625; // probe grid (same 4:5 as the other probes)
const WASM_DIR = join(ROOT, "apps/client/public/mediapipe/wasm") + "/";
const MODEL = join(ROOT, "apps/client/public/models/face_landmarker.task");
const BUNDLE = join(ROOT, "node_modules/@mediapipe/tasks-vision/vision_bundle.mjs");

function ffmpeg() {
  const candidates = [process.env.FFMPEG ?? "", "ffmpeg", join(homedir(), ".hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg")];
  for (const c of candidates) {
    if (!c) continue;
    try {
      execFileSync(c, ["-version"], { stdio: "ignore" });
      return c;
    } catch {}
  }
  throw new Error("ffmpeg not found; set FFMPEG=<path>");
}
const FF = ffmpeg();

mkdirSync(OUT_DIR, { recursive: true });
const raw = join(tmpdir(), `opl-render-landmarks-${process.pid}.rgb`);
execFileSync(FF, ["-y", "-i", FACE, "-vf", `scale=${W}:${H}`, "-f", "rawvideo", "-pix_fmt", "rgb24", raw]);
const rgb = readFileSync(raw);

// The pinned anchor table (mirrors coach/measure.ts MEASURE_INDICES and
// the spec appendix); highlighted on the render with their index number.
const MEASURE_ANCHORS = [10, 152, 127, 356, 172, 397, 103, 332, 61, 291, 33, 263, 4, 234, 454];
const ZONE_ANCHORS = [205, 425, 133, 145, 230, 362, 374, 450, 175, 199, 109, 338, 168, 6, 0, 148, 377];
const RIBBON_ANCHORS = [54, 21, 162, 284, 251, 389, 136, 150, 149, 176, 365, 379, 378, 400, 116, 345, 50, 280];
const HILITE = new Set([...MEASURE_ANCHORS, ...ZONE_ANCHORS, ...RIBBON_ANCHORS]);
const RIBBON_PATHS = {
  temple_L: [103, 54, 21, 162],
  temple_R: [332, 284, 251, 389],
  jaw_L: [172, 136, 150, 149, 176],
  jaw_R: [397, 365, 379, 378, 400],
  cheek_shelf_L: [234, 116, 50],
  cheek_shelf_R: [454, 345, 280],
  under_chin: [148, 152, 377],
  hairline_top: [109, 10, 338],
};
const RIBBON_COLOR = "#20c4ff";

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: W + 220, height: H } });
page.on("pageerror", (e) => { console.error("[pageerror]", String(e)); process.exitCode = 1; });

// Serve the wasm + model from disk; everything else is the blank page.
await page.route("**/*", async (route) => {
  const url = route.request().url();
  if (url.includes("/wasm/")) {
    const file = WASM_DIR + url.split("/wasm/")[1];
    try {
      await route.fulfill({ body: readFileSync(file), contentType: url.endsWith(".js") ? "text/javascript" : "application/wasm" });
    } catch { await route.abort(); }
  } else if (url.includes("model.task")) {
    await route.fulfill({ body: readFileSync(MODEL), contentType: "application/octet-stream" });
  } else {
    await route.fulfill({ contentType: "text/html", body: "<html><body style='margin:0'></body></html>" });
  }
});
await page.goto("http://localhost/blank.html", { waitUntil: "load" });

// Load the ESM bundle inside the page via a blob URL (file: imports are
// blocked; the bundle itself only needs window/document, which the page has).
await page.evaluate(async (src) => {
  const url = URL.createObjectURL(new Blob([src], { type: "text/javascript" }));
  const mod = await import(url);
  (window).V = { FilesetResolver: mod.FilesetResolver, FaceLandmarker: mod.FaceLandmarker };
}, readFileSync(BUNDLE, "utf8"));

const dataUrl = await page.evaluate(async ({ rgbArr, W, H, hilite, ribbons, measureSet }) => {
  const hiliteSet = new Set(hilite);
  const measure = new Set(measureSet);
  const fileset = await window.V.FilesetResolver.forVisionTasks("/wasm");
  const modelBuf = await (await fetch("/model.task")).arrayBuffer();
  const lm = await window.V.FaceLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetBuffer: new Uint8Array(modelBuf) },
    runningMode: "IMAGE",
    numFaces: 1,
  });

  const cv = document.createElement("canvas");
  cv.width = W; cv.height = H;
  const ctx = cv.getContext("2d");
  const img = ctx.createImageData(W, H);
  const bytes = Uint8Array.from(rgbArr);
  for (let p = 0; p < W * H; p++) {
    img.data[p * 4] = bytes[p * 3];
    img.data[p * 4 + 1] = bytes[p * 3 + 1];
    img.data[p * 4 + 2] = bytes[p * 3 + 2];
    img.data[p * 4 + 3] = 255;
  }
  ctx.putImageData(img, 0, 0);

  const result = lm.detect(cv);
  const face = result.faceLandmarks?.[0];
  if (!face || face.length < 468) throw new Error("no face detected on the fixture");
  (window).__pts = face.map((p) => [p.x * W, p.y * H]);

  // dim the photo slightly so the overlay reads
  ctx.fillStyle = "rgba(0,0,0,0.18)";
  ctx.fillRect(0, 0, W, H);

  // ribbon centerlines (thin strokes; the geometry itself lives in coach/zones.ts)
  ctx.lineWidth = 2.5;
  for (const [id, idxs] of Object.entries(ribbons)) {
    ctx.strokeStyle = id === "under_chin" || id === "hairline_top" ? "#ffd020" : "#20c4ff";
    ctx.beginPath();
    idxs.forEach((idx, i) => {
      const p = face[idx];
      if (!p) return;
      const x = p.x * W, y = p.y * H;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.stroke();
  }

  // all 478 mesh dots
  ctx.fillStyle = "rgba(255,255,255,0.75)";
  for (const p of face) {
    ctx.beginPath();
    ctx.arc(p.x * W, p.y * H, 1.2, 0, Math.PI * 2);
    ctx.fill();
  }

  // highlighted anchors: ring + index number on the side ruler
  const legend = [];
  ctx.font = "10px monospace";
  for (let i = 0; i < face.length; i++) {
    const p = face[i];
    const x = p.x * W, y = p.y * H;
    if (hiliteSet.has(i)) {
      ctx.strokeStyle = measure.has(i) ? "#ff4060" : "#40ff90";
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.arc(x, y, 5, 0, Math.PI * 2);
      ctx.stroke();
      legend.push({ i, x, y });
    }
  }
  // side ruler: numbered labels, lines to their dots
  const panel = document.createElement("canvas");
  panel.width = W + 220; panel.height = H;
  const pctx = panel.getContext("2d");
  pctx.drawImage(cv, 0, 0);
  pctx.font = "9px monospace";
  legend.sort((a, b) => a.y - b.y);
  legend.forEach((q, rank) => {
    const ly = 14 + rank * ((H - 28) / Math.max(1, legend.length - 1));
    pctx.strokeStyle = "rgba(255,255,255,0.35)";
    pctx.lineWidth = 0.7;
    pctx.beginPath();
    pctx.moveTo(q.x, q.y);
    pctx.lineTo(W + 6, ly);
    pctx.stroke();
    pctx.fillStyle = measure.has(q.i) ? "#ff4060" : "#40ff90";
    pctx.beginPath(); pctx.arc(W + 6, ly, 2.5, 0, Math.PI * 2); pctx.fill();
    pctx.fillText(String(q.i), W + 12, ly + 3);
  });
  // caption
  pctx.fillStyle = "#ffffff";
  pctx.font = "11px monospace";
  pctx.fillText("mesh dots: 478 | red ring: measurement anchors | green ring: zone/ribbon anchors", 8, H - 8);
  return panel.toDataURL("image/png");
}, { rgbArr: Array.from(rgb), W, H, hilite: [...HILITE], ribbons: RIBBON_PATHS, measureSet: [...new Set(MEASURE_ANCHORS)] });

const out = join(OUT_DIR, "face-portrait-overview.png");
writeFileSync(out, Buffer.from(dataUrl.split(",")[1], "base64"));
try { unlinkSync(raw); } catch {}
console.log("wrote", out);
await browser.close();
