import test from "node:test";
import assert from "node:assert/strict";
import {
  keepLooksMounted,
  pageFromStrip,
  stageAfterCoachBack,
  stageAfterLooksDemo,
  stageAfterTeach,
  type AppStage,
} from "./stageNav.ts";

test("Looks demo with a lock lands on looks; Teach lands on coach; Back stays camera", () => {
  let stage: AppStage = "coach";
  const hasLock = true;
  stage = stageAfterLooksDemo(hasLock);
  assert.equal(stage, "looks");
  assert.equal(keepLooksMounted(stage, hasLock), true);

  stage = stageAfterTeach();
  assert.equal(stage, "coach");
  assert.equal(keepLooksMounted(stage, hasLock), true);

  stage = stageAfterLooksDemo(hasLock);
  assert.equal(stage, "looks");
  assert.equal(stageAfterCoachBack(), "camera");
});

test("Looks demo without a lock lands on camera and does not mount looks", () => {
  assert.equal(stageAfterLooksDemo(false), "camera");
  assert.equal(keepLooksMounted("coach", false), false);
  assert.equal(keepLooksMounted("camera", true), false);
  assert.equal(keepLooksMounted("looks", true), true);
  assert.equal(keepLooksMounted("photo", true), false);
});

test("a parked strip with no width does not change the open card", () => {
  assert.equal(pageFromStrip(0, 0), null);
  assert.equal(pageFromStrip(400, 0), null);
  assert.equal(pageFromStrip(Number.NaN, 320), null);
  assert.equal(pageFromStrip(0, 320), 0);
  assert.equal(pageFromStrip(320, 320), 1);
  assert.equal(pageFromStrip(640, 320), 2);
  assert.equal(pageFromStrip(900, 320), 2);
});
