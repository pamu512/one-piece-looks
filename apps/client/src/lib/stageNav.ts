export type AppStage = "camera" | "photo" | "looks" | "coach";

/** Looks demo returns to the built looks when a lock is held; otherwise the camera. */
export function stageAfterLooksDemo(hasLock: boolean): "looks" | "camera" {
  return hasLock ? "looks" : "camera";
}

/** Back always leaves the coach for the camera. */
export function stageAfterCoachBack(): "camera" {
  return "camera";
}

/** Teach / Live coach opens the coach. */
export function stageAfterTeach(): "coach" {
  return "coach";
}

/**
 * The looks stage stays mounted across a coach round-trip so the strip
 * and the open role are still there on return. It only mounts once a
 * lock exists — without one, the looks stage has nothing to show.
 */
export function keepLooksMounted(stage: AppStage, hasLock: boolean): boolean {
  return hasLock && (stage === "looks" || stage === "coach");
}

/**
 * Which card is centered. A hidden strip reports width 0; that reading is
 * not a swipe, so the caller keeps the page it already had.
 */
export function pageFromStrip(scrollLeft: number, clientWidth: number, count = 3): number | null {
  if (!(clientWidth > 0) || !Number.isFinite(scrollLeft) || !(count > 0)) return null;
  const i = Math.round(scrollLeft / clientWidth);
  if (!Number.isFinite(i)) return null;
  return Math.max(0, Math.min(count - 1, i));
}
