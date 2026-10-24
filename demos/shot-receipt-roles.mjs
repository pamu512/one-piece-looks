#!/usr/bin/env node
/** Swipe to Lift/Statement and verify the receipt chip tracks the look. */
import { chromium } from "playwright";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "demos", "polish-prove-20261024");
const faceB64 = readFileSync(join(ROOT, "apps/client/public/fixtures/face-portrait-live.jpg")).toString("base64");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true });
const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"] });
const page = await ctx.newPage();
page.setDefaultTimeout(60000);
await page.addInitScript((d) => {
  let track = null;
  navigator.mediaDevices.getUserMedia = async () => {
    if (!track) {
      const img = new Image();
      img.src = d;
      await new Promise((r) => { img.onload = r; img.onerror = r; });
      const c = document.createElement("canvas");
      c.width = 480; c.height = 640;
      const x = c.getContext("2d");
      x.fillStyle = "#101014";
      x.fillRect(0, 0, 480, 640);
      const ar = img.naturalWidth / img.naturalHeight, tar = 480 / 640;
      let sw = img.naturalWidth, sh = img.naturalHeight;
      if (ar > tar) sw = sh * tar; else sh = sw / tar;
      x.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, 480, 640);
      track = c.captureStream(12).getVideoTracks()[0];
    }
    return new MediaStream([track.clone()]);
  };
}, "data:image/png;base64," + faceB64);

await page.goto("http://127.0.0.1:5173", { waitUntil: "domcontentloaded" });
const entry = await page.waitForSelector(".coach-back, .shutter:not([disabled])");
if (((await entry.getAttribute("class")) ?? "").includes("coach-back")) await entry.click();
await page.waitForSelector(".shutter:not([disabled])");
await sleep(1200);
await page.click(".shutter");
await page.waitForSelector(".lock-ring");
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
  return b && !b.disabled;
});
await page.click("text=/See my three looks/i");
await page.waitForSelector(".look-frame img:not(.bare-img)");
await sleep(2000);

for (const [name, thumb] of [["lift", 2], ["statement", 3]]) {
  await page.click(`.thumb:nth-child(${thumb})`);
  await sleep(900);
  const chip = ((await page.textContent(".receipt-chip")) ?? "").trim();
  console.log(`${name.toUpperCase()} chip: "${chip}"`);
  if (name === "statement") {
    await page.click(".receipt-chip");
    await page.waitForSelector(".receipt-sheet");
    const rows = await page.$$eval(".receipt-sheet .receipt-row", (els) => els.map((e) => ({
      name: e.querySelector(".receipt-name")?.textContent.trim(),
      detail: e.querySelector(".receipt-detail")?.textContent.trim(),
      locked: !!e.querySelector(".locked-tag"),
    })));
    console.log(`statement rows (${rows.length}):`);
    for (const r of rows) console.log(`  ${r.locked ? "[LOCKED] " : ""}${r.name} — ${r.detail}`);
    await page.screenshot({ path: join(OUT, "statement-receipt.png") });
  }
}
await browser.close();
process.exit(0);
