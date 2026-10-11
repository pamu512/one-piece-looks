#!/usr/bin/env node
/**
 * Contour 2AFC (follow-up to C2, 2026-10-11): does SHAPE-AWARE contour
 * placement read more sculpted than the old static pair?
 *
 * Stimulus set, same blind protocol as demos/make-c2-2afc.mjs:
 *   per face, two builds through the REAL app (fake camera -> lip lock ->
 *   build): "shaped" (the app sends its coach classification) and "static"
 *   (route interception strips landmarks.faceShape, so the server uses the
 *   pre-2026-10-11 neutral jaw patches). Statement and Lift renders pair
 *   static-vs-shaped; the judge answers "which reads more sculpted?".
 *
 * Ground truth for scoring = the shaped render. NOTE the quantity confound,
 * reported by the scorer: round/square shapes place 4 stamps vs the static
 * 2, so their pairs test more-paint AND placement; heart/diamond/triangle/
 * long place differently at similar counts, isolating placement.
 *
 * Output: demos/contour-2afc/{index.html,trials.json,stimuli.json,renders/}
 * Usage: node demos/make-contour-2afc.mjs
 * Env:   FACES=... TRIALS=3 ROLES="Statement,Lift" MOOD_EVENT="Soft|Casual"
 */
import { chromium } from "playwright";
import { readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, "demos", "contour-2afc");
const RENDERS = join(OUT, "renders");
const FACES = (process.env.FACES ?? "face-a-curly,face-b-pulled-back,face-c-blonde,face-d-tan").split(",");
const ROLES = (process.env.ROLES ?? "Statement,Lift").split(",");
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

/**
 * One full app run for a face. stripShape=true installs a route that removes
 * landmarks.faceShape from the /face POST, forcing the server's static
 * (pre-shape-aware) contour placement. Also reports the shape the app sent.
 */
async function buildForFace(face, stripShape) {
  const facePath = join(ROOT, "demos/.mask-qa/faces", `${face}.png`);
  if (!existsSync(facePath)) throw new Error(`missing fixture ${facePath}`);
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, permissions: ["camera"],
  });
  const page = await context.newPage();
  page.setDefaultTimeout(45000);
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  let sentShape = "(none)";
  if (stripShape) {
    await page.route("**/api/session/*/face", async (route) => {
      const req = route.request();
      try {
        const body = req.postDataJSON();
        if (body?.landmarks?.faceShape) sentShape = `${body.landmarks.faceShape} (stripped)`;
        else sentShape = "(none)";
        if (body?.landmarks) delete body.landmarks.faceShape;
        return route.continue({ postData: JSON.stringify(body) });
      } catch {
        return route.continue();
      }
    });
  } else {
    await page.route("**/api/session/*/face", async (route) => {
      try {
        const body = route.request().postDataJSON();
        sentShape = body?.landmarks?.faceShape ?? "(none)";
      } catch {}
      return route.continue();
    });
  }

  const faceB64 = readFileSync(facePath).toString("base64");
  await page.addInitScript((fd) => {
    navigator.mediaDevices.getUserMedia = async () => {
      const img = new Image(); img.src = fd;
      await new Promise((r) => { img.onload = r; img.onerror = r; });
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

  const out = { sentShape };
  const slides = page.locator(".look-slide .role-pill");
  const n = await slides.count();
  for (let i = 0; i < n; i++) {
    const role = (await slides.nth(i).textContent()).trim();
    const src = await page.evaluate((idx) => {
      return document.querySelectorAll(".look-frame img:not(.bare-img)")[idx].src;
    }, i);
    out[role] = src;
  }
  if (errors.length) console.log(`  [${face}${stripShape ? " static" : " shaped"}] page errors:`, errors.slice(0, 3));
  await context.close();
  return out;
}

const trials = [];
const meta = {};

for (const face of FACES) {
  console.log(`capturing ${face}: shaped…`);
  const shaped = await buildForFace(face, false);
  console.log(`  app sent faceShape: ${shaped.sentShape}`);
  console.log(`capturing ${face}: static…`);
  const statik = await buildForFace(face, true);
  console.log(`  static run sent: ${statik.sentShape}`);
  if (shaped.sentShape === "(none)") {
    console.log(`  [${face}] no classification -> shaped==static; skipping face`);
    continue;
  }
  meta[face] = { shape: shaped.sentShape };
  for (const role of ROLES) {
    if (!shaped[role] || !statik[role]) continue;
    const pngShaped = `r${hash(face + role + "shaped" + shaped[role])}.png`;
    const pngStatic = `r${hash(face + role + "static" + statik[role])}.png`;
    if (!existsSync(join(RENDERS, pngShaped))) await rasterize(shaped[role], join(RENDERS, pngShaped));
    if (!existsSync(join(RENDERS, pngStatic))) await rasterize(statik[role], join(RENDERS, pngStatic));
    const rng = mulberry32(hash(`${face}|${role}|contour`).charCodeAt(0) * 7919 + face.length + role.length);
    for (let t = 0; t < TRIALS; t++) {
      const leftIsShaped = rng() < 0.5;
      trials.push({
        id: trials.length,
        face,
        role,
        left: leftIsShaped ? `renders/${pngShaped}` : `renders/${pngStatic}`,
        right: leftIsShaped ? `renders/${pngStatic}` : `renders/${pngShaped}`,
        leftIsShaped,
        moreSculpted: "shaped",
      });
    }
  }
}

writeFileSync(join(OUT, "stimuli.json"), JSON.stringify({
  t: new Date().toISOString(),
  mood: MOOD, event: EVENT, trialsPerPair: TRIALS, roles: ROLES,
  faces: FACES, faceShapes: meta,
  key: trials.map((t) => ({ id: t.id, face: t.face, role: t.role, leftIsShaped: t.leftIsShaped, moreSculpted: t.moreSculpted })),
}, null, 2));

writeFileSync(join(OUT, "trials.json"), JSON.stringify({
  trials: trials.map((t) => ({ id: t.id, left: t.left, right: t.right })),
}, null, 2));

const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>2AFC — which reads more sculpted?</title>
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
  <h1>Which face reads more sculpted?</h1>
  <p class="sub">Pick the face whose shading and light read more defined and sculpted. Same face, two placements. One tap per trial.</p>
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
const storeKey = "contour-2afc-answers";
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

console.log(`\nwrote ${trials.length} trials (${FACES.length} faces x ${ROLES.length} roles x ${TRIALS})`);
console.log(`open: demos/contour-2afc/index.html`);
await browser.close();
