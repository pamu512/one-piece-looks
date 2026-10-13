#!/usr/bin/env node
/**
 * Fake-camera still for the live coach shape hold.
 *
 * After the face read settles, the shape word must stay the same for 8s.
 * Teach me N must equal Step i of N for every step. Writes a screenshot
 * of the coach bar and the lesson card.
 *
 *   node scripts/prove-coach-hold.mjs
 *   OPL_URL=http://127.0.0.1:5173 FACE=path/to/still.png node scripts/prove-coach-hold.mjs
 *
 * Needs the client dev server (default stage is the live coach) and
 * apps/client/public/models/face_landmarker.task.
 */
import { chromium } from "playwright";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const URL = process.env.OPL_URL || "http://127.0.0.1:5173/";
const OUT = process.env.OUT || "/tmp/opl-coach-hold";
mkdirSync(OUT, { recursive: true });

function ffmpegBin() {
  const candidates = [
    process.env.FFMPEG || "",
    "ffmpeg",
    join(homedir(), ".hermes/tools/ffmpeg-9.0.1-darwin-arm64/ffmpeg"),
  ].filter(Boolean);
  for (const bin of candidates) {
    const r = spawnSync(bin, ["-version"], { encoding: "utf8" });
    if (r.status === 0) return bin;
  }
  throw new Error("ffmpeg not found; set FFMPEG=<path>");
}

function faceStill() {
  const candidates = [
    process.env.FACE || "",
    join(ROOT, "demos/.mask-qa/faces/face-c-blonde.png"),
    join(ROOT, "apps/server/fixtures/face-portrait-live.jpg"),
  ].filter(Boolean);
  const hit = candidates.find((p) => existsSync(p));
  if (!hit) throw new Error("no face still; set FACE=<png or jpg>");
  return hit;
}

function ensureY4m(still) {
  const y4m = join(OUT, "face.y4m");
  if (existsSync(y4m) && statSync(y4m).size > 1_000_000 && process.env.REUSE_Y4M === "1") return y4m;
  const ff = ffmpegBin();
  const r = spawnSync(ff, [
    "-y",
    "-loop", "1",
    "-i", still,
    "-t", "40",
    "-r", "8",
    "-vf", "scale=480:640:force_original_aspect_ratio=increase,crop=480:640",
    "-pix_fmt", "yuv420p",
    "-f", "yuv4mpegpipe",
    y4m,
  ], { encoding: "utf8" });
  if (r.status !== 0) throw new Error("ffmpeg y4m failed: " + (r.stderr || "").slice(-500));
  return y4m;
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

const still = faceStill();
const y4m = ensureY4m(still);
const result = { url: URL, still, y4m, settled: null, shapeSamples: [], teach: null, steps: [], screenshot: null };

const browser = await chromium.launch({
  headless: true,
  args: [
    "--use-fake-ui-for-media-stream",
    "--use-fake-device-for-media-stream",
    `--use-file-for-fake-video-capture=${y4m}`,
    "--autoplay-policy=no-user-gesture-required",
  ],
});
const context = await browser.newContext({
  permissions: ["camera"],
  viewport: { width: 390, height: 844 },
});
const page = await context.newPage();
const logs = [];
page.on("pageerror", (e) => logs.push(String(e)));

try {
  await page.goto(URL, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForSelector('section[aria-label="Live contour coach"]', { timeout: 15000 });
  await page.waitForFunction(() => {
    const t = document.querySelector(".coach-live-shape")?.textContent || "";
    return /Your read:/.test(t) && !/Reading/.test(t);
  }, null, { timeout: 25000 });

  // The first publish can land ~2s after the default oval. Wait until the
  // word has sat still for 3s (cap 20s), then measure a fresh 8s window.
  const settleDeadline = Date.now() + 20000;
  let settled = "";
  let settledAt = 0;
  while (Date.now() < settleDeadline) {
    const text = (await page.locator(".coach-live-shape").innerText()).replace(/\s+/g, " ").trim();
    if (text === settled) {
      if (Date.now() - settledAt >= 3000) break;
    } else {
      settled = text;
      settledAt = Date.now();
    }
    await page.waitForTimeout(500);
  }
  assert(settled && Date.now() - settledAt >= 3000, "shape word did not settle: " + settled);
  result.settled = settled;

  for (let i = 0; i < 9; i++) {
    const text = (await page.locator(".coach-live-shape").innerText()).replace(/\s+/g, " ").trim();
    result.shapeSamples.push(text);
    if (i < 8) await page.waitForTimeout(1000);
  }
  const unique = [...new Set(result.shapeSamples)];
  assert(unique.length === 1, "shape word changed during 8s: " + JSON.stringify(result.shapeSamples));

  const teachText = (await page.locator("button.coach-teach").innerText()).replace(/\s+/g, " ").trim();
  const teachN = Number((teachText.match(/(\d+)\s+steps/) || [])[1]);
  assert(Number.isInteger(teachN) && teachN > 0, "Teach me count missing: " + teachText);
  result.teach = { text: teachText, n: teachN };

  await page.locator("button.coach-teach").click();
  await page.waitForSelector(".lesson-card", { timeout: 5000 });

  const shot = join(OUT, "bar-and-lesson.png");
  await page.locator(".coach-live-bar").screenshot({ path: shot });
  result.screenshot = shot;

  for (let guard = 0; guard < teachN + 1; guard++) {
    const countText = (await page.locator(".lesson-count").innerText()).replace(/\s+/g, " ").trim();
    const m = countText.match(/Step (\d+) of (\d+)/i);
    assert(m, "step line missing: " + countText);
    const i = Number(m[1]);
    const n = Number(m[2]);
    result.steps.push({ i, n, text: countText });
    assert(n === teachN, `Step ${i} of ${n} but Teach me said ${teachN}`);
    assert(i === result.steps.length, `expected step ${result.steps.length}, saw ${i}`);
    const next = page.locator(".lesson-card").getByRole("button", { name: /^(Next|Done)$/ });
    const label = (await next.innerText()).trim();
    if (i === n) {
      assert(label === "Done", "last step should offer Done, saw " + label);
      break;
    }
    assert(label === "Next", "expected Next, saw " + label);
    await next.click();
  }
  assert(result.steps.length === teachN, `walked ${result.steps.length} steps, Teach me said ${teachN}`);
  result.ok = true;
} catch (e) {
  result.ok = false;
  result.error = String(e?.stack || e);
  await page.screenshot({ path: join(OUT, "error.png"), fullPage: true }).catch(() => {});
} finally {
  result.pageErrors = logs;
  writeFileSync(join(OUT, "result.json"), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result, null, 2));
  await browser.close();
}

process.exit(result.ok ? 0 : 1);
