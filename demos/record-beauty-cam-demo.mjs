import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { mkdirSync, copyFileSync, statSync, readdirSync, unlinkSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const FIX = join(ROOT, "apps/client/public/fixtures");
const OUT_DIR = join(ROOT, "demos");
const VIDEO_DIR = join(OUT_DIR, ".pw-video-beauty");
const MP4 = join(OUT_DIR, "opl-beauty-cam-demo-20261005.mp4");
const TMP_MP4 = "/tmp/opl-beauty-cam-demo-20261005.mp4";
const CHECK = join(OUT_DIR, "opl-beauty-cam-demo-20261005-checklist.json");
const FACE = join(FIX, "face-portrait-live.jpg");
const BASE = "http://127.0.0.1:5173";

mkdirSync(VIDEO_DIR, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function choosePhoto(page, filePath) {
  const label = page.locator("label").filter({ hasText: /Choose a photo|No camera/i }).first();
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

async function snapText(page) {
  return page.evaluate(() => {
    const body = document.body?.innerText || "";
    const imgs = [...document.querySelectorAll(".look-card img, .looks-strip img")].map((i) => ({
      alt: i.getAttribute("alt") || "",
      w: i.naturalWidth,
      h: i.naturalHeight,
      srcKind: (i.getAttribute("src") || "").startsWith("data:image/svg")
        ? "svg-data"
        : (i.getAttribute("src") || "").startsWith("data:")
          ? "data"
          : "url",
    }));
    const buttons = [...document.querySelectorAll("button")].map((b) => (b.innerText || "").trim()).filter(Boolean).slice(0, 40);
    return { body: body.slice(0, 2500), imgs, buttons };
  });
}

async function scrollStrip(page, leftFrac, holdMs) {
  await page.evaluate((f) => {
    const strip = document.querySelector(".looks-strip");
    if (!strip) return;
    strip.scrollTo({ left: strip.scrollWidth * f, behavior: "smooth" });
  }, leftFrac);
  await sleep(holdMs);
}

async function main() {
  const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
  console.log("health", health);
  if (!health?.ok || health.mock !== true) throw new Error("need mock:true on :8787");
  const vite = await fetch(BASE).then((r) => r.status);
  console.log("vite", vite);
  if (vite !== 200) throw new Error("vite not up");

  for (const f of readdirSync(VIDEO_DIR)) {
    try { unlinkSync(join(VIDEO_DIR, f)); } catch {}
  }

  const checklist = {
    beats: {
      cameraOrFileFallback: false,
      zoneTapLock: false,
      panOrSkip: false,
      softCasualVisible: false,
      buildThreeLooks: false,
      horizontalLooksWithFaceImages: false,
      shuffle: false,
      notOldWizard: true,
    },
    frames: [],
  };

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
    deviceScaleFactor: 2,
    recordVideo: { dir: VIDEO_DIR, size: { width: 390, height: 844 } },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(30000);
  await page.addInitScript(() => {
    const deny = () => Promise.reject(Object.assign(new Error("Permission denied"), { name: "NotAllowedError" }));
    if (navigator.mediaDevices) {
      navigator.mediaDevices.getUserMedia = deny;
      navigator.mediaDevices.enumerateDevices = async () => [];
    }
  });

  console.log("open app");
  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.getByText(/One piece\. Three looks/i).waitFor({ timeout: 15000 });
  await sleep(5000); // hold title + camera stage
  checklist.frames.push({ t: "camera", ...(await snapText(page)) });

  try {
    await page.getByText("Camera unavailable").waitFor({ timeout: 6000 });
  } catch {}
  console.log("file fallback face photo");
  await choosePhoto(page, FACE);
  checklist.beats.cameraOrFileFallback = true;
  await sleep(4000);

  console.log("zone tap Lip");
  await page.getByRole("button", { name: /Lip zone/i }).waitFor({ timeout: 20000 });
  checklist.frames.push({ t: "zones", ...(await snapText(page)) });
  await sleep(2500); // show zone dots before tap
  await page.getByRole("button", { name: /Lip zone/i }).click();
  await sleep(2500);

  if (await page.getByRole("button", { name: /Continue with this color/i }).isVisible().catch(() => false)) {
    console.log("skin gate: continue");
    await sleep(2000);
    await page.getByRole("button", { name: /Continue with this color/i }).click();
    await sleep(1500);
  }

  await page.getByText(/Step 2 of 2|We're building from the color|Dress the moment/i).first().waitFor({ timeout: 20000 });
  checklist.beats.zoneTapLock = true;
  await sleep(4000);
  checklist.frames.push({ t: "locked", ...(await snapText(page)) });

  const soft = page.getByRole("button", { name: "Soft", exact: true });
  const casual = page.getByRole("button", { name: "Casual", exact: true });
  await soft.waitFor({ state: "visible" });
  await casual.waitFor({ state: "visible" });
  if ((await soft.getAttribute("aria-pressed")) !== "true") await soft.click();
  if ((await casual.getAttribute("aria-pressed")) !== "true") await casual.click();
  checklist.beats.softCasualVisible = true;
  await sleep(3500);

  console.log("skip pan");
  const skip = page.getByRole("button", { name: /Skip, use what is on my face/i });
  if (await skip.isVisible().catch(() => false)) {
    await skip.click();
    checklist.beats.panOrSkip = true;
    await sleep(3000);
  } else if (await page.getByText(/pan color set/i).isVisible().catch(() => false)) {
    checklist.beats.panOrSkip = true;
  }
  checklist.frames.push({ t: "prebuild", ...(await snapText(page)) });

  console.log("wait face then build");
  await page.getByRole("button", { name: /Build my three looks/i }).waitFor({ state: "visible" });
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /Build my three looks/i.test(x.textContent || ""));
    return b && !b.disabled;
  }, null, { timeout: 45000 });
  await sleep(2500);
  await page.getByRole("button", { name: /Build my three looks/i }).click();
  checklist.beats.buildThreeLooks = true;
  await sleep(2000); // building chip

  console.log("looks stage");
  await page.getByRole("heading", { name: /Built around your/i }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Anchor", exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Lift", exact: true }).waitFor({ timeout: 45000 });
  await page.getByRole("heading", { name: "Statement", exact: true }).waitFor({ timeout: 45000 });
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".look-card img")];
    return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 45000 });
  await sleep(5000);
  checklist.frames.push({ t: "looks", ...(await snapText(page)) });

  await scrollStrip(page, 0, 2000);
  await scrollStrip(page, 0.35, 3500);
  await scrollStrip(page, 0.7, 3500);
  await scrollStrip(page, 1, 3500);
  await scrollStrip(page, 0, 2500);

  const lookSnap = await snapText(page);
  const faceImgs = (lookSnap.imgs || []).filter((i) => i.w > 0);
  checklist.beats.horizontalLooksWithFaceImages =
    faceImgs.length >= 3 &&
    !/Bullet or gloss|Choose the mood|Wear it, then shoot/i.test(lookSnap.body || "");
  if (/Bullet or gloss|Choose the mood|Wear it, then shoot/i.test(lookSnap.body || "")) {
    checklist.beats.notOldWizard = false;
  }

  console.log("shuffle");
  await page.getByRole("button", { name: /^Shuffle$/i }).click();
  await sleep(3000);
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".look-card img")];
    return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 45000 }).catch(() => {});
  checklist.beats.shuffle = true;
  await sleep(5000);
  await scrollStrip(page, 0.5, 3500);
  await scrollStrip(page, 1, 3000);
  checklist.frames.push({ t: "shuffled", ...(await snapText(page)) });
  await sleep(4000);

  const raw = await page.video().path();
  await context.close();
  await browser.close();
  console.log("raw", raw);

  const ff = spawnSync("ffmpeg", [
    "-y", "-i", raw,
    "-c:v", "libx264", "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an",
    "-vf", "scale=trunc(iw/2)*2:trunc(ih/2)*2",
    "-crf", "23",
    MP4,
  ], { encoding: "utf8" });
  if (ff.status !== 0) {
    console.error(ff.stderr?.slice(-1200));
    throw new Error("ffmpeg failed");
  }
  copyFileSync(MP4, TMP_MP4);
  const st = statSync(MP4);
  const probe = spawnSync("ffprobe", [
    "-v", "error",
    "-show_entries", "format=duration,size",
    "-of", "json",
    MP4,
  ], { encoding: "utf8" });
  const meta = JSON.parse(probe.stdout || "{}");
  checklist.mp4 = { path: MP4, tmp: TMP_MP4, bytes: st.size, durationSec: Number(meta.format?.duration || 0) };
  writeFileSync(CHECK, JSON.stringify(checklist, null, 2));
  console.log("mp4", MP4, "bytes", st.size, "duration", checklist.mp4.durationSec);
  console.log("checklist", JSON.stringify(checklist.beats));
  console.log("DONE");
}

main().catch((e) => { console.error("RECORD_FAIL", e); process.exit(1); });
