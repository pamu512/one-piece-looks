/**
 * Coach overlay: "show me where" — the plan's zones and ribbons painted on
 * the user's own face photo.
 *
 * Geometry: buildContourMap runs in the normalized reference frame (roll
 * rotated horizontal, divided by interocular distance). To draw on the
 * photo we invert: multiply by IOD, rotate by +roll. Step colors come from
 * the plan's shadeHex (server-parity formulas), so what the user sees is
 * what the looks paint.
 */

import { useMemo } from "react";
import { buildContourMap, type ZoneOrRibbon, type Pt } from "../lib/coach/zones.ts";
import { normalizeFace } from "../lib/coach/measure.ts";
import { lastMeshPoints } from "../lib/faceMesh.ts";
import type { CoachStep } from "../lib/coach/plan.ts";

const VB_W = 1000;
const VB_H = 1250;

const VERB_FILL: Record<string, number> = {
  contour: 0.55,
  warm: 0.5,
  define: 0.5,
  brighten: 0.45,
};

interface Props {
  /** The bare face photo (data URL), same source as the capture. */
  photo: string;
  /** The coach plan; each step highlights its zones. */
  steps: CoachStep[];
  /** Index of the step being shown; null shows all at once. */
  activeStep: number | null;
}

export function CoachOverlay({ photo, steps, activeStep }: Props) {
  const map = useMemo(() => {
    const raw = lastMeshPoints();
    if (!raw || raw.length < 468) return null;
    const norm = normalizeFace(raw);
    if (!norm) return null;
    return { norm, cm: buildContourMap(norm) };
  }, []);

  if (!map) {
    return (
      <div className="coach-overlay-empty">
        <p>Face map needs a frontal photo — retake facing the mirror.</p>
      </div>
    );
  }

  const { norm, cm } = map;
  // Inverse of normalizeFace's transform (rotate by -roll, scale by 1/iod):
  // scale back by iod, then rotate by +roll. Verified against the raw mesh:
  // cheek 205 at frame (0.228, 0.619) round-trips to (0.230, 0.618).
  const roll = (norm.rollDeg * Math.PI) / 180;
  const cos = Math.cos(roll);
  const sin = Math.sin(roll);
  const toFrame = (q: Pt): Pt => {
    const sx = q.x * norm.iod;
    const sy = q.y * norm.iod;
    return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
  };
  const poly = (pts: readonly Pt[]) =>
    pts.map((q) => {
      const f = toFrame(q);
      return `${(f.x * VB_W).toFixed(1)},${(f.y * VB_H).toFixed(1)}`;
    }).join(" ");

  const shown = activeStep === null ? steps : [steps[activeStep]!].filter(Boolean);
  const byId = new Map<string, { fill: string; op: number }>();
  for (const [si, s] of shown.entries()) {
    const op = VERB_FILL[s.verb] ?? 0.45;
    for (const id of s.zoneIds) {
      if (!byId.has(id)) byId.set(id, { fill: s.shadeHex, op: op * (activeStep === null ? 0.7 : 1) });
    }
    void si;
  }

  const shapes = [...cm.zones, ...cm.ribbons] as ZoneOrRibbon[];
  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="coach-overlay" role="img"
      aria-label="Face map showing where each step applies">
      <image href={photo} x={0} y={0} width={VB_W} height={VB_H} preserveAspectRatio="xMidYMid slice" />
      {shapes
        .filter((z) => byId.has(z.id))
        .map((z) => {
          const style = byId.get(z.id)!;
          return (
            <polygon key={z.id} points={poly(z.poly)} fill={style.fill} fillOpacity={style.op}
              stroke={style.fill} strokeWidth={2.5} strokeOpacity={0.85} />
          );
        })}
    </svg>
  );
}
