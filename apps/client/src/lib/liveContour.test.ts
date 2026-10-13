import test from "node:test";
import assert from "node:assert/strict";
import {
  buildLesson,
  freshShapeStreak,
  holdShape,
  resolveGuideLesson,
  syncShapeStreak,
  type LessonStep,
  type ShapeStreak,
} from "./liveContour.ts";

function titles(steps: readonly LessonStep[]): string[] {
  return steps.map((s) => s.title);
}

function push(shape: string, streak: ShapeStreak, candidate: string): { shape: string; streak: ShapeStreak } {
  return holdShape(shape, candidate, streak);
}

test("oval, pear, oval does not flip the published shape", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  for (const candidate of ["oval", "pear", "oval"]) {
    ({ shape, streak } = push(shape, streak, candidate));
  }
  assert.equal(shape, "oval");
  assert.equal(streak.count, 0);
  assert.equal(streak.pending, "");
});

test("three identical pear samples flip the published shape once", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  const seen: string[] = [];
  for (const _ of [1, 2, 3, 4]) {
    ({ shape, streak } = push(shape, streak, "pear"));
    seen.push(shape);
  }
  assert.deepEqual(seen, ["oval", "oval", "pear", "pear"]);
  assert.equal(streak.count, 0);
});

test("face loss and regain clear a partial streak", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  let facePresent = true;
  ({ shape, streak } = push(shape, streak, "pear"));
  ({ shape, streak } = push(shape, streak, "pear"));
  assert.equal(streak.count, 2);

  ({ streak, facePresent } = syncShapeStreak(streak, facePresent, false));
  assert.equal(facePresent, false);
  assert.equal(streak.count, 0);
  assert.equal(shape, "oval");

  // Regain zeroes again, then the new run starts at one — it does not finish the old one.
  const dirty: ShapeStreak = { pending: "pear", count: 2 };
  ({ streak, facePresent } = syncShapeStreak(dirty, false, true));
  assert.equal(streak.count, 0);
  ({ shape, streak } = push(shape, streak, "pear"));
  ({ shape, streak } = push(shape, streak, "pear"));
  assert.equal(shape, "oval");
  assert.equal(streak.count, 2);

  // Presence that did not change keeps the run.
  const stable = syncShapeStreak(streak, true, true);
  assert.equal(stable.streak, streak);
});

test("one opposite sample after a lock does not flip back", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  for (let i = 0; i < 3; i++) ({ shape, streak } = push(shape, streak, "pear"));
  assert.equal(shape, "pear");
  ({ shape, streak } = push(shape, streak, "oval"));
  assert.equal(shape, "pear");
  assert.deepEqual(streak, { pending: "oval", count: 1 });
  ({ shape, streak } = push(shape, streak, "pear"));
  assert.equal(shape, "pear");
  assert.equal(streak.count, 0);
  assert.equal(streak.pending, "");
});

test("a different label starts the count over", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  ({ shape, streak } = push(shape, streak, "pear"));
  ({ shape, streak } = push(shape, streak, "pear"));
  ({ shape, streak } = push(shape, streak, "heart"));
  assert.equal(shape, "oval");
  assert.deepEqual(streak, { pending: "heart", count: 1 });
});

test("a missed sample does not vote and does not clear a run", () => {
  let shape = "oval";
  let streak = freshShapeStreak();
  ({ shape, streak } = push(shape, streak, "pear"));
  ({ shape, streak } = push(shape, streak, "pear"));
  const held = streak;
  ({ shape, streak } = holdShape(shape, null, streak));
  assert.equal(streak, held);
  ({ shape, streak } = holdShape(shape, "", streak));
  assert.equal(streak, held);
  assert.equal(shape, "oval");
  assert.equal(streak.count, 2);
  ({ shape, streak } = push(shape, streak, "pear"));
  assert.equal(shape, "pear");
  assert.equal(streak.count, 0);
});

test("a broken count cannot publish on the next sample", () => {
  const held = holdShape("oval", "pear", { pending: "pear", count: Number.NaN });
  assert.equal(held.shape, "oval");
  assert.deepEqual(held.streak, { pending: "pear", count: 1 });
});

test("holdShape leaves the streak argument unchanged", () => {
  const streak: ShapeStreak = { pending: "pear", count: 2 };
  holdShape("oval", "pear", streak);
  holdShape("oval", null, streak);
  assert.deepEqual(streak, { pending: "pear", count: 2 });
});

test("startGuide snapshot stays stable across a shape change and finishSweep", () => {
  const oval = buildLesson("oval");
  const pear = buildLesson("pear");
  assert.equal(oval.length, 4);
  assert.equal(pear.length, 3);
  assert.notDeepEqual(titles(oval), titles(pear));

  // The click handler freezes the list the Teach me button just showed.
  const locked = oval.slice();
  assert.deepEqual(titles(resolveGuideLesson(locked, "pear")), titles(oval));
  assert.equal(resolveGuideLesson(locked, "pear").length, 4);

  // finishSweep reclassifies through the same live shape channel.
  assert.deepEqual(titles(resolveGuideLesson(locked, "heart")), titles(oval));
  assert.equal(resolveGuideLesson(locked, "heart").length, oval.length);

  // Stop or Done drops the snapshot; the card follows the live shape again.
  assert.deepEqual(titles(resolveGuideLesson(null, "pear")), titles(pear));
  assert.equal(resolveGuideLesson(null, "pear").length, 3);
  assert.deepEqual(resolveGuideLesson(null, undefined), []);
});
