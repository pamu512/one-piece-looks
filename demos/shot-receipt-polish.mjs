#!/usr/bin/env node
/**
 * Receipt-sheet + calm-topbar + labeled-actions walkthrough (plan 2026-10-24).
 * Drives the real UI headlessly (fake camera face, mock server behind vite)
 * and checks, with DOM + computed styles + screenshots:
 *   R1  "What's on · N layers" chip on the looks stage, real chip count.
 *   R2  Receipt sheet opens: swatch + name + shade note per row; row 1 LOCKED.
 *   R3  Calm top bar: lock chip + one overflow menu (Live coach, Start over);
 *       no pips in the looks top bar.
 *   R4  Labeled bottom actions: Save / Shuffle / Share, labels ~10.5px.
 *   R5  Bottom bar paints a see-through gradient (rgba stops, not a slab).
 * Prints PASS/FAIL per check with values; exit 0 only if all pass.
 */
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, "..");
const OUT = join(ROOT, "demos", "polish-prove-20261024");
mkdirSync(OUT, { recursive: true });
const BASE = "http://127.0.0.1:5173";
const FACE = join(ROOT, "apps/client/public/fixtures/face-portrait-live.jpg");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function record(id, pass, detail) {
  results.push({ id, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${id}  ${detail}`);
}

const faceB64 = readFileSync(FACE).toString("base64");
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
});
const page = await context.newPage();
page.setDefaultTimeout(60000);
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
// Coach-first boot: leave the mirror via Back before shooting.
const entry = await page.waitForSelector(".coach-back, .shutter:not([disabled])");
if ((await entry.getAttribute("class"))?.includes("coach-back")) await entry.click();
await page.waitForSelector(".shutter:not([disabled])");
await sleep(1200);
await page.click(".shutter");
await page.waitForSelector(".lock-ring");
await page.waitForFunction(() => {
  const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
  return b && !b.disabled;
});
await sleep(400);
await page.click("text=/See my three looks/i");
await page.waitForSelector(".look-frame img:not(.bare-img)");
await sleep(2500);

// R1: receipt chip with the real layer count from POST /looks chips.
const chipText = (await page.textContent(".receipt-chip"))?.trim() ?? "";
const chipMatch = chipText.match(/^What's on · (\d+) layers?$/);
record("R1-receipt-chip", !!chipMatch && Number(chipMatch[1]) >= 1, `chip text "${chipText}"`);

// R4 + R5 while the stage is idle.
const labels = await page.$$eval(".act-label", (els) => els.map((e) => e.textContent?.trim()));
record("R4-action-labels", labels.join(",") === "Save,Shuffle,Share", `labels [${labels.join(", ")}]`);
const labelPx = await page.$eval(".act-label", (el) => getComputedStyle(el).fontSize);
record("R4-label-size", labelPx === "10.5px", `font-size ${labelPx}`);
const barBg = await page.$eval(".bottom-bar", (el) => getComputedStyle(el).backgroundImage);
const seeThrough = /rgba\(8, ?9, ?11, ?0\.(3[0-9]|6[0-9])\)/.test(barBg);
record("R5-soft-gradient", seeThrough, `bar gradient ${barBg.slice(0, 110)}…`);
await page.screenshot({ path: join(OUT, "looks-stage.png") });

// R2: open the receipt sheet; first row locked, every row has swatch + note.
await page.click(".receipt-chip");
await page.waitForSelector(".receipt-sheet");
const rows = await page.$$eval(".receipt-sheet .receipt-row", (els) =>
  els.map((el) => ({
    name: el.querySelector(".receipt-name")?.textContent?.trim() ?? "",
    detail: el.querySelector(".receipt-detail")?.textContent?.trim() ?? "",
    hex: el.querySelector(".receipt-hex")?.textContent?.trim() ?? "",
    swatch: !!el.querySelector(".receipt-swatch"),
    locked: !!el.querySelector(".locked-tag"),
  })));
const rowCount = rows.length;
const chipCountOk = chipMatch ? rowCount === Number(chipMatch[1]) : false;
const allReal = rows.every((r) => r.swatch && r.name && r.hex.startsWith("#"));
record("R2-sheet-rows", chipCountOk && rowCount >= 1 && rows[0].locked && !rows[1]?.locked && allReal,
  `${rowCount} rows (chip said ${chipMatch?.[1]}), row1 locked=${rows[0]?.locked}, all have swatch+name+hex=${allReal}`);
await page.screenshot({ path: join(OUT, "receipt-sheet.png") });
await page.keyboard.press("Escape");
await sleep(300);
const sheetGone = (await page.$(".receipt-sheet")) === null;
record("R2-escape-closes", sheetGone, `sheet closed by Escape: ${sheetGone}`);

// R3: calm top bar — lock chip, overflow menu, no pips.
const lockText = (await page.textContent(".lock-chip"))?.trim() ?? "";
record("R3-lock-chip", /Your (lip|cheek|eye|brow|liner), kept/.test(lockText), `lock chip "${lockText}"`);
const pipsInLooks = await page.$(".stage-looks .topbar .pips");
record("R3-no-pips", pipsInLooks === null, `pips absent in looks topbar: ${pipsInLooks === null}`);
await page.click(".more-btn");
await page.waitForSelector(".menu-pop");
const menuItems = await page.$$eval(".menu-pop .menu-item", (els) => els.map((e) => e.textContent?.trim()));
record("R3-overflow-menu", menuItems.join(",") === "Live coach,Start over", `menu [${menuItems.join(", ")}]`);
await page.screenshot({ path: join(OUT, "overflow-menu.png") });
await page.keyboard.press("Escape");
await sleep(250);
const menuGone = (await page.$(".menu-pop")) === null;
record("R3-menu-escape", menuGone, `menu closed by Escape: ${menuGone}`);

await browser.close();
const failed = results.filter((r) => !r.pass);
console.log(failed.length === 0 ? `ALL ${results.length} CHECKS PASSED` : `${failed.length} CHECK(S) FAILED`);
process.exit(failed.length === 0 ? 0 : 1);
