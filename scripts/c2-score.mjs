#!/usr/bin/env node
/**
 * Score a completed C2 blind 2AFC run.
 *
 * Usage: node scripts/c2-score.mjs [answers.json]
 *   answers.json = the JSON you pasted back from the review page
 *                  ({ t, answers: { trialId: "L" | "R" } }).
 *                  Reads stdin if no path given.
 *
 * Gate (from the 2026-10-07 verdict): the judge should identify the fuller
 * look in each pair significantly above chance. We report per-pair and
 * overall accuracy with an exact binomial p-value (one-sided, chance 0.5),
 * and PASS requires >= 75% overall AND >= 2/3 correct on every pair type,
 * all trials answered. 2AFC convention: this tests discrimination, not
 * preference - "which reads more made-up" has a ground truth (the role
 * with more layers painted).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stimuli = JSON.parse(readFileSync(join(ROOT, "demos", "c2-2afc", "stimuli.json"), "utf8"));

const raw = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : readFileSync(0, "utf8");
const submitted = JSON.parse(raw);
const answers = submitted.answers ?? submitted;

/** One-sided exact binomial: P(X >= k | n, 0.5). */
function binomP(k, n) {
  // exact via log-factorials to survive n up to a few hundred
  const lf = (m) => { let s = 0; for (let i = 2; i <= m; i++) s += Math.log(i); return s; };
  let p = 0;
  for (let x = k; x <= n; x++) {
    p += Math.exp(lf(n) - lf(x) - lf(n - x) - n * Math.LN2);
  }
  return Math.min(1, Math.max(0, p));
}

const key = new Map(stimuli.key.map((k) => [k.id, k]));
const perPair = {};
let correct = 0, total = 0;
const misses = [];

for (const [idStr, side] of Object.entries(answers)) {
  const id = Number(idStr);
  const k = key.get(id);
  if (!k) continue; // stale trial from an older generation
  // moreMadeUp is the role with more layers; the judge picks L or R.
  // leftIsA tells us which side role A of the pair sat on.
  const [roleA, roleB] = k.pair.split("<");
  const leftRole = k.leftIsA ? roleA : roleB;
  const rightRole = k.leftIsA ? roleB : roleA;
  const picked = side === "L" ? leftRole : rightRole;
  const ok = picked === k.moreMadeUp;
  perPair[k.pair] ??= { n: 0, ok: 0 };
  perPair[k.pair].n += 1;
  if (ok) { perPair[k.pair].ok += 1; correct += 1; }
  else misses.push({ id, pair: k.pair, picked, truth: k.moreMadeUp, face: stimuli.key.length ? undefined : undefined });
  total += 1;
}

const expected = stimuli.key.length;
console.log(`trials answered: ${total}/${expected}`);
if (total < expected) {
  console.log(`INCOMPLETE - answer all ${expected} trials before scoring.`);
  process.exit(2);
}

console.log("\nper pair:");
let pairsPass = true;
for (const [pair, { n, ok }] of Object.entries(perPair)) {
  const acc = ok / n;
  const pass = acc >= 0.5 + 1 / (2 * n); // strictly above chance per pair
  if (!pass) pairsPass = false;
  console.log(`  ${pair.padEnd(22)} ${ok}/${n}  (${(acc * 100).toFixed(0)}%)  ${pass ? "ok" : "AT CHANCE"}`);
}

const acc = correct / total;
const p = binomP(correct, total);
const overallPass = acc >= 0.75 && pairsPass;
console.log(`\noverall: ${correct}/${total} (${(acc * 100).toFixed(0)}%), exact binomial p = ${p.toExponential(2)}`);
if (misses.length) console.log("misses:", misses.map((m) => `#${m.id} ${m.pair} picked ${m.picked}`).join(" | "));
console.log(`\nC2 GATE ${overallPass ? "PASS" : "FAIL"} (>=75% overall + every pair above chance)`);
process.exit(overallPass ? 0 : 1);
