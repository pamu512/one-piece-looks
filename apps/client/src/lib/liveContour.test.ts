import test from "node:test";
import assert from "node:assert/strict";
import {
  GHOST_ALPHA,
  GHOST_RADIUS,
  GHOST_SAMPLES,
  STROKE_ALPHA,
  STROKE_HEAD_CAP,
  STROKE_RADIUS,
  STROKE_SAMPLES,
  TEACHING_GREY,
  YAW_FRONTAL_DEG,
  brushProgress,
  buildLesson,
  contourRibbonsForShape,
  faceYawDeg,
  freshShapeStreak,
  holdShape,
  paintContourLayer,
  paintRibbonIds,
  resolveGuideLesson,
  ribbonVisible,
  strokeAlphas,
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

test("locked guide ids survive a different live shape", () => {
  const locked = contourRibbonsForShape("oblong");
  const live = contourRibbonsForShape("oval");
  assert.notDeepEqual([...locked], [...live]);
  const painted = paintRibbonIds("oval", locked);
  assert.equal(painted, locked);
  for (const id of locked) assert.equal(live.includes(id), false);
});

test("null guide ids follow the live shape", () => {
  assert.deepEqual([...paintRibbonIds("oval", null)], [...contourRibbonsForShape("oval")]);
  assert.deepEqual([...paintRibbonIds("oblong", null)], [...contourRibbonsForShape("oblong")]);
  assert.notDeepEqual([...paintRibbonIds("oval", null)], [...paintRibbonIds("oblong", null)]);
});

test("ghost alpha and radius stay below the stroke", () => {
  assert.equal(GHOST_ALPHA, 0.04);
  assert.equal(GHOST_RADIUS, 0.028);
  assert.equal(GHOST_SAMPLES, 12);
  assert.equal(STROKE_ALPHA, 0.22);
  assert.equal(STROKE_RADIUS, 0.04);
  assert.equal(STROKE_HEAD_CAP, 0.5);
  assert.deepEqual(TEACHING_GREY, [180, 184, 192]);
  assert.ok(GHOST_ALPHA < STROKE_ALPHA);
  assert.ok(GHOST_RADIUS < STROKE_RADIUS);
});

test("guided progress is monotone and holds at 1 after 0.8", () => {
  let prev = 0;
  for (let i = 0; i <= 16; i++) {
    const t = (i / 16) * 0.8;
    const p = brushProgress(t, 0, true);
    assert.ok(p >= prev && p >= 0 && p <= 1, `t ${t} -> ${p}`);
    prev = p;
  }
  assert.equal(brushProgress(0, 0, true), 0);
  assert.ok(Math.abs(brushProgress(0.4, 0, true) - 0.5) < 1e-9);
  assert.equal(brushProgress(0.8, 0, true), 1);
  assert.equal(brushProgress(0.91, 0, true), 1);
  assert.equal(brushProgress(0.999, 0, true), 1);
  assert.equal(brushProgress(0.25, 0.5, false), 0.75);
  const wrapped = brushProgress(0.9, 0.3, false);
  assert.ok(Math.abs(wrapped - 0.2) < 1e-9);
  assert.ok(wrapped >= 0 && wrapped <= 1);
});

test("at progress 0.5 samples past the head are 0 and the head sample is the max", () => {
  const alphas = strokeAlphas(8, 0.5);
  assert.equal(alphas.length, 8);
  assert.deepEqual(alphas.slice(4), [0, 0, 0, 0]);
  const head = alphas[3]!;
  assert.ok(head > 0);
  assert.equal(head, Math.max(...alphas));
  for (let i = 0; i < 3; i++) assert.ok(alphas[i]! < head);
  assert.ok(alphas.every((a) => a <= STROKE_HEAD_CAP));
  const full = strokeAlphas(8, 1);
  assert.equal(full[7], Math.max(...full));
  assert.ok(full.every((a) => a > 0));
});

test("|yaw| < 10 shows both sides", () => {
  const noseX = 0.5;
  for (const yaw of [0, 9, -9, YAW_FRONTAL_DEG - 0.001]) {
    assert.ok(Math.abs(yaw) < YAW_FRONTAL_DEG);
    assert.equal(ribbonVisible({ x: 0.12, y: 0.5 }, yaw, noseX), true);
    assert.equal(ribbonVisible({ x: 0.88, y: 0.5 }, yaw, noseX), true);
  }
});

test("a turned face hides the far centroid and keeps the near one", () => {
  const earL = { x: 0.2, y: 0.4 };
  const earR = { x: 0.6, y: 0.4 };
  const noseRight = { x: 0.55, y: 0.5 };
  const yawRight = faceYawDeg(noseRight, earL, earR);
  assert.ok(Math.abs(yawRight - 22.5) < 1e-6);
  assert.ok(Math.abs(yawRight) >= YAW_FRONTAL_DEG);
  assert.equal(ribbonVisible({ x: 0.3, y: 0.55 }, yawRight, noseRight.x), true);
  assert.equal(ribbonVisible({ x: 0.8, y: 0.55 }, yawRight, noseRight.x), false);
  assert.equal(ribbonVisible({ x: noseRight.x + 0.01, y: 0.55 }, yawRight, noseRight.x), true);
  assert.equal(ribbonVisible({ x: noseRight.x + 0.05, y: 0.55 }, yawRight, noseRight.x), false);

  const noseLeft = { x: 0.25, y: 0.5 };
  const yawLeft = faceYawDeg(noseLeft, earL, earR);
  assert.ok(Math.abs(yawLeft + 22.5) < 1e-6);
  assert.equal(ribbonVisible({ x: 0.55, y: 0.55 }, yawLeft, noseLeft.x), true);
  assert.equal(ribbonVisible({ x: 0.05, y: 0.55 }, yawLeft, noseLeft.x), false);
  assert.equal(ribbonVisible({ x: 0.2, y: 0.5 }, YAW_FRONTAL_DEG, 0.5), true);
  assert.equal(ribbonVisible({ x: 0.9, y: 0.5 }, YAW_FRONTAL_DEG, 0.5), false);
});

test("missing ears yield yaw 0", () => {
  const nose = { x: 0.5, y: 0.4 };
  const ear = { x: 0.2, y: 0.4 };
  const other = { x: 0.8, y: 0.45 };
  assert.equal(faceYawDeg(nose, undefined, other), 0);
  assert.equal(faceYawDeg(nose, ear, undefined), 0);
  assert.equal(faceYawDeg(undefined, ear, other), 0);
  assert.equal(faceYawDeg(null, null, null), 0);
  assert.equal(faceYawDeg(nose, ear, { x: ear.x, y: ear.y }), 0);
  assert.equal(faceYawDeg({ x: Number.NaN, y: 0.5 }, ear, other), 0);
  assert.equal(faceYawDeg(nose, { x: 0.2, y: Number.POSITIVE_INFINITY }, other), 0);
  assert.equal(
    faceYawDeg({ x: 0.55, y: 0.5 }, { x: 0.2, y: 0.3 }, { x: 0.6, y: 0.5 }),
    ((0.55 - (0.2 + 0.6) / 2) / Math.hypot(0.6 - 0.2, 0.5 - 0.3)) * 60,
  );
});

test("a bad centroid stays hidden and a non-finite yaw does not occlude", () => {
  assert.equal(ribbonVisible({ x: Number.NaN, y: 0.5 }, 0, 0.5), false);
  assert.equal(ribbonVisible(null, 0, 0.5), false);
  assert.equal(ribbonVisible({ x: 0.2, y: 0.5 }, Number.NaN, 0.5), true);
  assert.equal(ribbonVisible({ x: 0.9, y: 0.5 }, Number.NaN, 0.5), true);
  assert.equal(ribbonVisible({ x: 0.2, y: 0.5 }, 30, Number.NaN), false);
});

test("brush progress stays in range when the clock is not", () => {
  assert.ok(Math.abs(brushProgress(Number.NaN, 0.2, false) - 0.2) < 1e-9);
  assert.ok(Math.abs(brushProgress(-0.2, 0, false) - 0.8) < 1e-9);
  assert.ok(Math.abs(brushProgress(1.2, 0, true) - brushProgress(0.2, 0, true)) < 1e-9);
  const held = brushProgress(-1.3, 0.1, true);
  assert.ok(held >= 0 && held <= 1);
  assert.deepEqual(strokeAlphas(5, 0), [0, 0, 0, 0, 0]);
  assert.deepEqual(strokeAlphas(0, 0.5), []);
  assert.deepEqual(strokeAlphas(4, 2), strokeAlphas(4, 1));
  assert.deepEqual(strokeAlphas(4, -1), strokeAlphas(4, 0));
});

function lineAt(x: number) {
  return [
    { x, y: 0.3 },
    { x, y: 0.45 },
    { x, y: 0.6 },
    { x, y: 0.75 },
  ];
}

function recordingCtx() {
  const alphas: number[] = [];
  const arcs: { x: number; y: number; r: number }[] = [];
  let pending = Number.NaN;
  return {
    alphas,
    arcs,
    fillStyle: "",
    createRadialGradient() {
      return {
        addColorStop(offset: number, color: string) {
          if (offset !== 0) return;
          const m = /rgba\(\d+,\d+,\d+,([^)]+)\)/.exec(color);
          pending = m ? Number(m[1]) : Number.NaN;
        },
      };
    },
    beginPath() {},
    arc(x: number, y: number, r: number) {
      arcs.push({ x, y, r });
    },
    fill() {
      alphas.push(pending);
    },
  };
}

test("a locked stroke paints through a shape change and a miss is skipped", () => {
  const ctx = recordingCtx();
  const W = 480;
  paintContourLayer(ctx as never, {
    width: W,
    height: 640,
    ribbons: [
      { id: "hairline_top", centerline: lineAt(0.5) },
      { id: "temple_L", centerline: lineAt(0.3) },
    ] as never,
    liveShape: "oval",
    guideIds: ["hairline_top", "missing_id"],
    yawDeg: 0,
    noseX: 0.5,
    cycleT: 0.4,
    guided: true,
  });
  assert.ok(ctx.arcs.length > 0);
  assert.ok(ctx.arcs.every((a) => a.x === 0.5 * W));
  const ghost = ctx.arcs.filter((a) => Math.abs(a.r - W * GHOST_RADIUS) < 1e-9);
  const stroke = ctx.arcs.filter((a) => Math.abs(a.r - W * STROKE_RADIUS) < 1e-9);
  assert.equal(ghost.length, GHOST_SAMPLES);
  assert.equal(ghost.length + stroke.length, ctx.arcs.length);
  const expected = strokeAlphas(STROKE_SAMPLES, brushProgress(0.4, 0, true)).filter((a) => a > 0);
  assert.equal(stroke.length, expected.length);
  for (let i = 0; i < ghost.length; i++) assert.ok(Math.abs(ctx.alphas[i]! - GHOST_ALPHA) < 1e-9);
  const painted = ctx.alphas.slice(ghost.length);
  assert.equal(painted[painted.length - 1], Math.max(...painted));
  for (let i = 0; i < expected.length; i++) assert.ok(Math.abs(painted[i]! - expected[i]!) < 1e-9);
  assert.ok(GHOST_ALPHA < Math.min(...painted));
  assert.ok(painted.every((a) => a <= STROKE_HEAD_CAP));
});

test("at progress 0 only the ghost paints", () => {
  const ctx = recordingCtx();
  paintContourLayer(ctx as never, {
    width: 100,
    height: 100,
    ribbons: [{ id: "hairline_top", centerline: lineAt(0.5) }] as never,
    liveShape: "oblong",
    guideIds: ["hairline_top"],
    yawDeg: 0,
    noseX: 0.5,
    cycleT: 0,
    guided: true,
  });
  assert.equal(ctx.arcs.length, GHOST_SAMPLES);
  assert.ok(ctx.alphas.every((a) => Math.abs(a - GHOST_ALPHA) < 1e-9));
});

test("null guide ids paint the live shape and a frontal frame paints both sides", () => {
  const ctx = recordingCtx();
  const W = 100;
  paintContourLayer(ctx as never, {
    width: W,
    height: 100,
    ribbons: [
      { id: "temple_L", centerline: lineAt(0.3) },
      { id: "temple_R", centerline: lineAt(0.7) },
      { id: "hairline_top", centerline: lineAt(0.5) },
    ] as never,
    liveShape: "oval",
    guideIds: null,
    yawDeg: 9,
    noseX: 0.5,
    cycleT: 0,
    guided: true,
  });
  const xs = new Set(ctx.arcs.map((a) => a.x));
  assert.equal(xs.size, 2);
  assert.ok(xs.has(0.3 * W));
  assert.ok(xs.has(0.7 * W));
  assert.equal(xs.has(0.5 * W), false);
});

test("a turned face skips the whole far ribbon, including its near points", () => {
  const ctx = recordingCtx();
  const W = 200;
  paintContourLayer(ctx as never, {
    width: W,
    height: 200,
    ribbons: [
      {
        id: "far",
        centerline: [
          { x: 0.4, y: 0.2 },
          { x: 0.4, y: 0.4 },
          { x: 0.9, y: 0.6 },
          { x: 0.9, y: 0.8 },
        ],
      },
      { id: "near", centerline: lineAt(0.2) },
    ] as never,
    liveShape: "oval",
    guideIds: ["far", "near"],
    yawDeg: 30,
    noseX: 0.5,
    cycleT: 0.2,
    guided: false,
  });
  assert.ok(ctx.arcs.length > 0);
  assert.ok(ctx.arcs.every((a) => Math.abs(a.x - 0.2 * W) < 1e-9));
});

test("a zero-size frame paints nothing", () => {
  const ctx = recordingCtx();
  paintContourLayer(ctx as never, {
    width: 0,
    height: 640,
    ribbons: [{ id: "hairline_top", centerline: lineAt(0.5) }] as never,
    liveShape: "oblong",
    guideIds: null,
    yawDeg: 0,
    noseX: 0.5,
    cycleT: 0.5,
    guided: false,
  });
  assert.equal(ctx.arcs.length, 0);
});
