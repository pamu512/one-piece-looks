#!/usr/bin/env node
/**
 * HTTP prove path (lipstick): POST real JPEG base64 for face (+ lock),
 * then looks + shuffle. Mock OK. Does not Devpost / Final Submit.
 *
 * Usage:
 *   node scripts/prove-lipstick.mjs
 *   BASE=http://127.0.0.1:8787 node scripts/prove-lipstick.mjs
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");
const BASE = process.env.BASE ?? "http://127.0.0.1:8787";
const FIX = join(ROOT, "apps/server/fixtures");
const OUT = process.env.PROVE_OUT ?? `/tmp/opl-lipstick-prove-${process.pid}.jsonl`;

const facePath = process.env.PROVE_FACE ?? join(FIX, "face-portrait-live.jpg");
const productPath = join(FIX, "lipstick-tube.jpg");

const faceBuf = readFileSync(facePath);
const productBuf = readFileSync(productPath);
const faceImageBase64 = faceBuf.toString("base64");

// Lock hexes for lipstick demo (on-face lock color). Product image is
// available for UI sampling; prove uses stable demo hexes.
const LOCK = {
  category: "lip",
  onFaceHex: "#b3122e",
  productHex: "#c01830",
  unverified: false,
};

const lines = [];
function log(label, data) {
  const row = { t: new Date().toISOString(), label, ...data };
  lines.push(JSON.stringify(row));
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(data, null, 2));
}

async function http(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  return { status: res.status, json };
}

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

console.log("fixtures:", { facePath, productPath, faceBytes: faceBuf.length, productBytes: productBuf.length });
console.log("faceImageBase64 length:", faceImageBase64.length, "(not stand-in a*4000)");
assert(faceImageBase64.length > 1000, "face base64 too short");
assert(faceBuf[0] === 0xff && faceBuf[1] === 0xd8, "face must be JPEG");
assert(productBuf[0] === 0xff && productBuf[1] === 0xd8, "product must be JPEG");

const health = await http("GET", "/health");
log("health", health);
assert(health.status === 200 && health.json?.ok, "server /health failed — is mock on :8787?");

const session = await http("POST", "/api/session", {});
log("session", session);
assert(session.status === 200 && session.json.sessionId, "session create failed");
const id = session.json.sessionId;

const face = await http("POST", `/api/session/${id}/face`, {
  faceImageBase64,
  lock: LOCK,
});
log("face", {
  status: face.status,
  skinType: face.json.skinType,
  toneFallback: face.json.toneFallback,
  tone: face.json.tone,
  toneHex: face.json.toneHex,
  sessionId: face.json.sessionId,
  error: face.json.error,
  code: face.json.code,
});
assert(face.status === 200, `face failed: ${JSON.stringify(face.json)}`);
assert(face.json.skinType, "expected skinType");

const looks = await http("POST", `/api/session/${id}/looks`, {
  mood: "Boss",
  event: "Office",
});
log("looks", {
  status: looks.status,
  rendersLeft: looks.json.rendersLeft,
  lockApproximated: looks.json.lockApproximated,
  roles: looks.json.looks?.map((l) => l.role),
  lockChips: looks.json.looks?.map((l) => ({
    role: l.role,
    firstChip: l.chips?.[0],
  })),
  error: looks.json.error,
  code: looks.json.code,
});
assert(looks.status === 200, `looks failed: ${JSON.stringify(looks.json)}`);
assert(looks.json.looks?.length === 3, "expected exactly 3 looks");
for (const look of looks.json.looks) {
  const chip = look.chips?.[0];
  assert(chip?.hex?.toLowerCase() === LOCK.onFaceHex.toLowerCase(), `lock hex missing on ${look.role}: ${chip?.hex}`);
  assert(/locked/i.test(chip?.detail ?? ""), `lock detail missing on ${look.role}`);
}

const shuffle = await http("POST", `/api/session/${id}/shuffle`, {});
log("shuffle", {
  status: shuffle.status,
  rendersLeft: shuffle.json.rendersLeft,
  roles: shuffle.json.looks?.map((l) => l.role),
  lockChips: shuffle.json.looks?.map((l) => ({
    role: l.role,
    firstChip: l.chips?.[0],
  })),
  imageUrlsChanged: shuffle.json.looks?.map((l, i) => l.imageUrl !== looks.json.looks[i]?.imageUrl),
  error: shuffle.json.error,
  code: shuffle.json.code,
});
assert(shuffle.status === 200, `shuffle failed: ${JSON.stringify(shuffle.json)}`);
for (const look of shuffle.json.looks) {
  const chip = look.chips?.[0];
  assert(chip?.hex?.toLowerCase() === LOCK.onFaceHex.toLowerCase(), `shuffle lock hex missing on ${look.role}`);
}

const summary = await http("GET", `/api/session/${id}`);
log("summary", summary);
assert(summary.json.hasFace && summary.json.hasLock, "summary missing face/lock");
assert(summary.json.mood === "Boss" && summary.json.event === "Office", "mood/event drifted");

writeFileSync(OUT, lines.join("\n") + "\n");
console.log("\nPROVE_OK");
console.log("evidence:", OUT);
console.log("lock:", LOCK);
console.log("rendersLeft after shuffle:", shuffle.json.rendersLeft);
process.exit(0);
