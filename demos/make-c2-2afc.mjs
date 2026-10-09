#!/usr/bin/env node
/**
 * C2 human blind 2AFC gate (filed 2026-10-07, outOfScopeFiled in
 * demos/soft-casual-p0p1-evidence-20261007.json).
 *
 * Generates the stimulus set for a human judge: per face, per pair
 * (Anchor-vs-Lift, Lift-vs-Statement, Anchor-vs-Statement), N trials with
 * randomized L/R placement. The judge sees two renders side by side, no
 * labels, and answers "which reads more made-up?" (the layering claim).
 *
 * Output:
 *   demos/c2-2afc/index.html        - self-contained review page (no server)
 *   demos/c2-2afc/stimuli.json      - the answer key (page never reads it)
 *   demos/c2-2afc/trials.json       - blind trial list the page loads
 *   demos/c2-2afc/renders/<...>.png - one png per render, rasterized by the
 *                                     same headless Chromium the probes use
 *
 * The page records answers into localStorage and exports a JSON the gate
 * script scores (scripts/c2-score.mjs). Blinding: filenames are hashes; the
 * roles/answers live only in stimuli.json, which the page does not fetch.
 *
 * Usage: node demos/make-c2-2afc.mjs
 * Env:   FACES="face-c-blonde,face-d-tan" (default: all four)
 *        TRIALS=3 (per pair; verdict asks 3)
 *        MOOD_EVENT="Soft|Casual" (default Soft|Casual - the shipped default)
 */
import { chromium } from "/tmp/opl-pw/node_modules/playwright/index.mjs";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "demos", "c2-2afc");
const RENDERS = join(OUT, "renders");
const FACES = (process.env.FACES ?? "face-a-curly,face-b-pulled-back,face-c-blonde,face-d-tan").split(",");
const TRIALS = Number(process.env.TRIALS ?? 3);
const [MOOD, EVENT] = (process.env.MOOD_EVENT ?? "Soft|Casual").split("|");
const BASE = "http://127.0.0.1:5173";

const health = await fetch("http://127.0.0.1:8787/health").then((r) => r.json());
if (!health?.ok || health.mock !== true) throw new Error("need mock server on :8787");
if ((await fetch(BASE).then((r) => r.status)) !== 200) throw new Error("vite not up on :5173");

mkdirSync(RENDERS, { recursive: true });
for (const f of readdirSync(OUT)) {
  if (f === "renders") continue;
  try { unlinkSync(join(OUT, f)); } catch {}
}

/** Deterministic shuffle so the run is reproducible (seeded by face+pair). */
function mulberry32(seed) {
  let a = seed;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function hash(s) { return createHash("sha1").update(s).digest("hex").slice(0, 12); }

const browser = await chromium.launch({ headless: true });
const rasterPage = await (await browser.newContext()).newPage();

async function rasterize(dataUrl, outPng) {
  const ok = await rasterPage.evaluate(async (url) => {
    const img = new Image();
    img.src = url;
    await new Promise((res) => { img.onload = res; img.onerror = () => res(null); });
    const c = document.createElement("canvas");
    c.width = img.naturalWidth || 1000;
    c.height = img.naturalHeight || 1250;
    c.getContext("2d").drawImage(img, 0, 0);
    window.__png = c.toDataURL("image/png");
    return img.naturalWidth > 0;
  }, dataUrl);
  if (!ok) throw new Error("rasterize failed");
  const b64 = (await rasterPage.evaluate(() => window.__png)).split(",")[1];
  writeFileSync(outPng, Buffer.from(b64, "base64"));
}

/** Drive the real app: fake camera -> lock -> build -> grab role renders. */
async function rendersForFace(face) {
  const facePath = join(ROOT, "demos/.mask-qa/faces", `${face}.png`);
  if (!existsSync(facePath)) throw new Error(`missing fixture ${facePath}`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));

  const faceB64 = readFileSync(facePath).toString("base64");
  await page.addInitScript((fd) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const img = new Image(); img.src = fd;
      await new Promise((r) => { img.onload = res0 = r; img.onerror = r; });
      var res0;
      const c = document.createElement("canvas"); c.width = 480; c.height = 640;
      const ctx = c.getContext("2d"); ctx.fillStyle = "#101014"; ctx.fillRect(0, 0, 480, 640);
      const ar = img.naturalWidth / img.naturalHeight, tar = 480 / 640;
      let sw = img.naturalWidth, sh = img.naturalHeight;
      if (ar > tar) sw = sh * tar; else sh = sw / tar;
      ctx.drawImage(img, (img.naturalWidth - sw) / 2, (img.naturalHeight - sh) / 2, sw, sh, 0, 0, 480, 640);
      return new MediaStream([c.captureStream(12).getVideoTracks()[0]]);
    };
  }, "data:image/png;base64," + faceB64);

  await page.goto(BASE, { waitUntil: "domcontentloaded" });
  await page.waitForSelector(".shutter:not([disabled])");
  await page.click(".shutter");
  await page.waitForSelector(".lock-ring");
  // Force the lip lock like the lip-align probe, so every face tests the
  // product's primary zone with the canonical lock hex.
  const lockLabel = await page.getAttribute(".lock-ring", "aria-label");
  if (!/lip/i.test(lockLabel || "")) {
    await page.click('.mini-btn:has-text("Adjust")').catch(() => {});
    await page.waitForTimeout(300);
    const box = await page.locator("canvas").first().boundingBox();
    await page.mouse.click(box.x + box.width * 0.445, box.y + box.height * 0.70);
    await page.waitForTimeout(500);
    const keep = page.locator("button", { hasText: /Keep it/i });
    if (await keep.isVisible().catch(() => false)) { await keep.click(); await page.waitForTimeout(300); }
  }
  await page.waitForFunction(() => {
    const b = [...document.querySelectorAll("button")].find((x) => /See my three looks/i.test(x.textContent || ""));
    return b && !b.disabled;
  }, null, { timeout: 60000 });
  await page.click("text=/See my three looks/i");
  await page.waitForSelector(".look-frame img:not(.bare-img)");
  await page.waitForFunction(() => {
    const imgs = [...document.querySelectorAll(".look-frame img:not(.bare-img)")];
    return imgs.length >= 3 && imgs.every((i) => i.complete && i.naturalWidth > 0);
  }, null, { timeout: 60000 });

  const out = {};
  const slides = page.locator(".look-slide .role-pill");
  const n = await slides.count();
  for (let i = 0; i < n; i++) {
    const role = (await slides.nth(i).textContent()).trim();
    const src = await page.evaluate((idx) => {
      return document.querySelectorAll(".look-frame img:not(.bare-img)")[idx].src;
    }, i);
    out[role] = src;
  }
  if (errors.length) console.log(`  [${face}] page errors:`, errors.slice(0, 3));
  await context.close();
  return out; // { Anchor: dataUrl, Lift: dataUrl, Statement: dataUrl }
}

const pairs = [["Anchor", "Lift"], ["Lift", "Statement"], ["Anchor", "Statement"]];
const opaqueByFace = {};
const trials = [];

for (const face of FACES) {
  console.log(`capturing ${face}…`);
  const roleSrcs = await rendersForFace(face);
  // Rasterize each role once per face; trials reuse the pngs.
  const pngs = {};
  const opaqueOf = {};
  for (const role of ["Anchor", "Lift", "Statement"]) {
    // Opaque name: the judge must not read roles from filenames.
    const opaque = `r${hash(face + role + roleSrcs[role])}.png`;
    const p = join(RENDERS, opaque);
    if (!existsSync(p)) await rasterize(roleSrcs[role], p);
    pngs[role] = `renders/${opaque}`;
    opaqueOf[role] = opaque;
  }
  opaqueByFace[face] = opaqueOf;
  for (const [a, b] of pairs) {
    const rng = mulberry32(hash(`${face}|${a}|${b}`) .charCodeAt(0) * 7919 + face.length);
    for (let t = 0; t < TRIALS; t++) {
      const leftIsA = rng() < 0.5;
      trials.push({
        id: trials.length,
        face,
        pair: `${a}<${b}`,
        left: leftIsA ? pngs[a] : pngs[b],
        right: leftIsA ? pngs[b] : pngs[a],
        leftIsA,
        // not shown to the judge
        moreMadeUp: b, // the layering claim: second role is fuller
      });
    }
  }
}

writeFileSync(join(OUT, "stimuli.json"), JSON.stringify({
  t: new Date().toISOString(),
  mood: MOOD, event: EVENT, trialsPerPair: TRIALS,
  faces: FACES,
  key: trials.map((t) => ({ id: t.id, pair: t.pair, leftIsA: t.leftIsA, moreMadeUp: t.moreMadeUp })),
  filesOpaque: Object.fromEntries(
    Object.entries(opaqueByFace).flatMap(([face, m]) =>
      Object.entries(m).map(([role, f]) => [`${face}-${role}`, f])),
  ),
}, null, 2));

// The BLIND trial list the page reads: image paths + ids only, no roles.
writeFileSync(join(OUT, "trials.json"), JSON.stringify({
  trials: trials.map((t) => ({ id: t.id, left: t.left, right: t.right })),
}, null, 2));

// Self-contained review page: inline css only, loads pngs relative, no answers.
const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>2AFC — which reads more made-up?</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; background:#0c0d10; color:#f4f2ee; font:16px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif; }
  main { max-width: 760px; margin: 0 auto; padding: 24px 16px calc(24px + env(safe-area-inset-bottom)); }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color:#b9b4ab; margin: 0 0 20px; font-size: 14px; }
  .pair { display:grid; grid-template-columns: 1fr 1fr; gap: 10px; margin-bottom: 12px; }
  .pair button { border: 2px solid rgba(255,255,255,.14); background:#14151a; border-radius: 14px;
    padding: 0; cursor: pointer; overflow: hidden; transition: border-color .12s, transform .12s; }
  .pair button:hover { border-color: rgba(255,255,255,.45); transform: translateY(-2px); }
  .pair img { display:block; width:100%; aspect-ratio: 4/5; object-fit: cover; }
  .tag { text-align:center; color:#7d7a72; font-size:12px; margin: 0 0 18px; }
  .tag b { color:#f4f2ee; }
  .bar { position: sticky; top: 0; background: linear-gradient(180deg,#0c0d10 70%, transparent);
    padding: 10px 0 14px; display:flex; justify-content:space-between; align-items:center; z-index: 2; }
  .bar .count { font-size: 14px; color:#b9b4ab; }
  .done { display:none; margin-top: 24px; padding: 18px; border:1px solid rgba(255,255,255,.16);
    border-radius: 14px; background:#14151a; }
  textarea { width:100%; height: 140px; background:#0c0d10; color:#f4f2ee; border:1px solid rgba(255,255,255,.2);
    border-radius: 10px; padding: 10px; font: 12px ui-monospace,monospace; box-sizing:border-box; }
  .hint { color:#7d7a72; font-size: 13px; }
  .trial { margin-bottom: 28px; }
  button.sel { border-color: #e0587a !important; }
</style></head>
<body><main>
  <h1>Which reads more made-up?</h1>
  <p class="sub">Pick the face wearing more makeup. No right answer you can compute — trust your eye. One tap per trial.</p>
  <div class="bar"><span class="count" id="count"></span><span class="hint">answers save on this device</span></div>
  <div id="trials"></div>
  <div class="done" id="done">
    <h2>All answered</h2>
    <p class="hint">Copy this JSON back to the agent (it holds no answers key):</p>
    <textarea id="result" readonly></textarea>
  </div>
</main>
<script type="module">
const stimuli = await fetch("trials.json").then(r => r.json());
const trials = stimuli.trials || [];
const storeKey = "c2-2afc-answers";
const answers = JSON.parse(localStorage.getItem(storeKey) || "{}");
const wrap = document.getElementById("trials");
const countEl = document.getElementById("count");
function renderCount() {
  const n = Object.keys(answers).length;
  countEl.textContent = n + " / " + trials.length + " answered";
  if (n >= trials.length) {
    const done = document.getElementById("done");
    done.style.display = "block";
    document.getElementById("result").value = JSON.stringify({ t: new Date().toISOString(), answers });
  }
}
for (const t of trials) {
  const div = document.createElement("div");
  div.className = "trial";
  div.innerHTML = '<div class="pair">' +
    '<button data-side="L"><img loading="lazy" src="' + t.left + '"></button>' +
    '<button data-side="R"><img loading="lazy" src="' + t.right + '"></button>' +
    '</div><p class="tag">Trial <b>' + (t.id + 1) + '</b></p>';
  div.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      answers[t.id] = b.dataset.side;
      localStorage.setItem(storeKey, JSON.stringify(answers));
      div.querySelectorAll("button").forEach((x) => x.classList.remove("sel"));
      b.classList.add("sel");
      renderCount();
    });
  });
  if (answers[t.id]) div.querySelector('[data-side="' + answers[t.id] + '"]').classList.add("sel");
  wrap.appendChild(div);
}
renderCount();
</script></body></html>`;
writeFileSync(join(OUT, "index.html"), page);

console.log(`\nwrote ${trials.length} trials (${FACES.length} faces x 3 pairs x ${TRIALS})`);
console.log(`open: demos/c2-2afc/index.html  (serve dir: npx serve demos/c2-2afc)`);
await browser.close();
