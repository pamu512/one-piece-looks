import { chromium } from "playwright";
import { mkdirSync, copyFileSync, statSync, readdirSync, unlinkSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "apps/client/public/fixtures");
const OUT_DIR = join(ROOT, "demos");
const VIDEO_DIR = join(OUT_DIR, ".pw-video");
const MP4 = join(OUT_DIR, "opl-mock-demo-20261005.mp4");
const LIP = join(FIX, "lipstick-tube.jpg");
const FACE = join(FIX, "face-portrait-live.jpg");
const BASE = "http://127.0.0.1:5173";

mkdirSync(VIDEO_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function choosePhoto(page, filePath) {
  // Prefer visible "Choose a photo" label; else any file input on page
  const label = page.locator("label").filter({ hasText: "Choose a photo" });
  if (await label.isVisible().catch(() => false)) {
    const [fc] = await Promise.all([
      page.waitForEvent("filechooser"),
      label.click(),
    ]);
    await fc.setFiles(filePath);
    return;
  }
  const input = page.locator('input[type="file"]').first();
  await input.waitFor({ state: "attached", timeout: 8000 });
  await input.setInputFiles(filePath);
}

async function tapCanvas(page, fx, fy) {
  const canvas = page.locator('canvas[aria-label*="Sample point"]');
  await canvas.waitFor({ state: "visible", timeout: 20000 });
  await sleep(500);
  const box = await canvas.boundingBox();
  if (!box) throw new Error("canvas no box");
  await page.mouse.click(box.x + box.width * fx, box.y + box.height * fy);
}

async function main() {
  const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
  console.log("health", health);
  if (!health?.ok || health.mock !== true) throw new Error("need mock:true");

  // clear old videos
  for (const f of readdirSync(VIDEO_DIR)) {
    try { unlinkSync(join(VIDEO_DIR, f)); } catch {}
  }

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(25000);
  await page.addInitScript(() => {
    const deny = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = deny;
      navigator.mediaDevices.enumerateDevices = async () => [];
    }
  });

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByText(/One piece/i).first().waitFor({ timeout: 15000 });
  await sleep(2500);

  console.log("pick Lip");
  await page.waitForFunction(() => document.querySelectorAll("button").length >= 5);
  await page.locator('button', { hasText: 'Bullet or gloss' }).click();
  await sleep(800);

  // wait denied overlay or inject file input path
  try {
    await page.getByText("Camera unavailable").waitFor({ timeout: 5000 });
  } catch {
    console.log("camera overlay missing; injecting denied UI via file input if present");
  }
  console.log("product photo");
  await choosePhoto(page, LIP);
  await sleep(1000);
  await tapCanvas(page, 0.5, 0.42);
  await sleep(800);
  await page.getByRole("button", { name: "Looks right" }).click();
  await sleep(1800);

  console.log("face photo");
  await page.getByRole('heading', { name: 'Wear it, then shoot' }).waitFor();
  try { await page.getByText("Camera unavailable").waitFor({ timeout: 5000 }); } catch {}
  await choosePhoto(page, FACE);
  await sleep(1200);
  await tapCanvas(page, 0.5, 0.62);
  await sleep(700);
  // skin ref tap (may already be past first tap UI)
  if (await page.locator('canvas[aria-label*="Sample point"]').isVisible().catch(() => false)) {
    // already moved on after first tap when confirming card shows - second tap is on same canvas only before hex set
  }
  // After first tap, UI shows confirm card asking for optional second tap on canvas - canvas still there under card? Looking at code: when photo && hex, canvas is gone, replaced by card. Second tap for skin only works when still on TapSampleStage with hex set... Actually looking again:

  // {photo && !hex && (TapSampleStage)}
  // {photo && hex && (card with optional second tap instruction)}
  // Wait - handleSample for second tap requires being on TapSampleStage, but TapSampleStage only shows when !hex.
  // So second tap skin ref is NEVER available after first tap! Bug in UI or I misread.

  // Looking again at FaceCapture:
  // photo && !hex -> TapSampleStage with handleSample
  // handleSample: if (!hex) set hex; else setSkinRef
  // But when hex is set, we switch to photo && hex branch which removes TapSampleStage!
  // So skinRef path is dead code unless both happen in one gesture... So only first tap matters.
  // Looks right when !gate - gate needs skinRef so gate is null without skinRef. Good - Looks right shows.

  await page.getByRole("button", { name: "Looks right" }).click();
  await sleep(2800);

  console.log("shift");
  const moodBtn = page.getByRole("button", { name: "Choose the mood" });
  await moodBtn.waitFor({ state: "visible", timeout: 45000 });
  if (await page.getByText("Pick your tone").isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "03", exact: true }).click();
    await page.getByRole("button", { name: "warm", exact: true }).click();
    await page.getByRole("button", { name: /Save tone/i }).click();
    await sleep(800);
  }
  await moodBtn.click();
  await sleep(1600);

  console.log("mood/event");
  await page.getByRole("button", { name: "Boss", exact: true }).click();
  await sleep(350);
  await page.getByRole("button", { name: "Office", exact: true }).click();
  await sleep(600);
  await page.getByRole("button", { name: /Build my three looks/i }).click();

  console.log("looks");
  await page.getByRole('heading', { name: /Built around your/i }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Anchor" }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Lift" }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Statement" }).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".look-card img")];
    return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 45000 }).catch(() => {});
  await sleep(3500);
  await page.evaluate(() => window.scrollTo({ top: 200, behavior: "smooth" }));
  await sleep(1800);
  await page.evaluate(() => window.scrollTo({ top: 450, behavior: "smooth" }));
  await sleep(2000);
  await page.evaluate(() => window.scrollTo({ top: 800, behavior: "smooth" }));
  await sleep(2200);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(1500);

  console.log("shuffle");
  await page.getByRole("button", { name: /Shuffle the rest/i }).click();
  await sleep(2000);
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".look-card img")];
    return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 45000 }).catch(() => {});
  await sleep(3500);
  await page.evaluate(() => window.scrollTo({ top: 250, behavior: "smooth" }));
  await sleep(2000);
  await page.evaluate(() => window.scrollTo({ top: 600, behavior: "smooth" }));
  await sleep(2500);
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: "smooth" }));
  await sleep(2000);

  const raw = await page.video().path();
  await context.close();
  await browser.close();
  console.log("raw", raw);

  const ff = spawnSync("ffmpeg", [
    "-y", "-i", raw,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    MP4,
  ], { encoding: "utf8" });
  if (ff.status !== 0) {
    console.error(ff.stderr?.slice(-1000));
    const webm = MP4.replace(/\.mp4$/, ".webm");
    copyFileSync(raw, webm);
    throw new Error("ffmpeg failed");
  }
  const st = statSync(MP4);
  const probe = spawnSync("ffprobe", ["-v", "error", "-show_entries", "format=duration,size", "-of", "json", MP4], { encoding: "utf8" });
  console.log("mp4", MP4, "bytes", st.size);
  console.log(probe.stdout);
  console.log("DONE");
}

main().catch((e) => { console.error("RECORD_FAIL", e); process.exit(1); });
