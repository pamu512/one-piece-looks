#!/usr/bin/env node
/**
 * Score a completed contour 2AFC run (demos/contour-2afc).
 *
 * Usage: node scripts/contour-2afc-score.mjs [answers.json]  (or stdin)
 *
 * Gate: the judge identifies the SHAPED render as more sculpted
 * significantly above chance. Exact binomial p-value (one-sided, 0.5).
 * PASS requires >= 70% overall AND p < 0.05, all trials answered, and
 * per-face breakdown reported (a win carried by one face is reported
 * as such - placement quality is per-shape).
 *
 * Known confound, reported not hidden: shapes that add stamps (round/
 * square: 4 vs static 2) test paint QUANTITY as well as placement. The
 * per-face table separates them from same-count shapes (long: 2 vs 2,
 * heart/diamond: different geometry).
 */
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const stimuli = JSON.parse(readFileSync(join(ROOT, "demos", "contour-2afc", "stimuli.json"), "utf8"));

const raw = process.argv[2]
  ? readFileSync(process.argv[2], "utf8")
  : readFileSync(0, "utf8");
const submitted = JSON.parse(raw);
const answers = submitted.answers ?? submitted;

// Exact one-sided binomial P(X >= k | n, 0.5) via log-factorial sums.
function logFactorial(n) {
  let s = 0;
  for (let i = 2; i <= n; i++) s += Math.log(i);
  return s;
}
function binomP(k, n) {
  // P(X >= k), X ~ Binom(n, 0.5)
  let p = 0;
  for (let i = k; i <= n; i++) {
    p += Math.exp(logFactorial(n) - logFactorial(i) - logFactorial(n - i) - n * Math.LN2);
  }
  return Math.min(1, p);
}

let total = 0, correct = 0, unanswered = 0;
const byFace = {};
for (const k of stimuli.key) {
  const a = answers[String(k.id)];
  if (a !== "L" && a !== "R") { unanswered++; continue; }
  total++;
  const pickedShaped = (a === "L") === k.leftIsShaped;
  if (pickedShaped) correct++;
  byFace[k.face] ??= { n: 0, c: 0, shape: stimuli.faceShapes?.[k.face]?.shape ?? "?" };
  byFace[k.face].n++;
  if (pickedShaped) byFace[k.face].c++;
}

console.log(`contour 2AFC — ${stimuli.mood}|${stimuli.event}, ${stimuli.t}`);
console.log(`faces: ${JSON.stringify(stimuli.faceShapes)}`);
if (unanswered) console.log(`WARNING: ${unanswered} trials unanswered (gate requires all)`);
console.log("");
console.log("| face | shape | correct |");
console.log("|---|---|---|");
for (const [face, s] of Object.entries(byFace)) {
  console.log(`| ${face} | ${s.shape} | ${s.c}/${s.n} (${Math.round((s.c / s.n) * 100)}%) |`);
}
const pct = total ? Math.round((correct / total) * 100) : 0;
const p = binomP(correct, total);
console.log("");
console.log(`overall: ${correct}/${total} (${pct}%) shaped picked as more sculpted, exact binomial p = ${p.toExponential(2)}`);

const pass = unanswered === 0 && total >= 10 && pct >= 70 && p < 0.05;
console.log(pass ? "PASS" : "FAIL");
process.exit(pass ? 0 : 1);
