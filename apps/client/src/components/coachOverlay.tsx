/**
 * Coach overlay: where each step sits on the user's photo.
 *
 * Geometry is buildContourMap in the normalized frame, drawn back through
 * IOD and roll. Pigment polygons use the step shade, a blend mode, and a
 * gaussian blur (lib/coach/fill.ts). Guide strokes are a second pass with
 * no blend and no blur, so the annotation stays a crisp vector. Paired
 * zone stems (cheek_apple) resolve to the _L/_R polygons.
 */

import { useMemo } from "react";
import { buildContourMap, type ZoneOrRibbon, type Pt } from "../lib/coach/zones.ts";
import { pointsAttr, zoneLayers } from "../lib/coach/fill.ts";
import { normalizeFace } from "../lib/coach/measure.ts";
import { lastMeshPoints } from "../lib/faceMesh.ts";
import type { CoachStep } from "../lib/coach/plan.ts";

const VB_W = 1000;
const VB_H = 1250;

interface Props {
  /** The bare face photo (data URL), same source as the capture. */
  photo: string;
  /** The coach plan; each step highlights its zones. */
  steps: CoachStep[];
  /** Index of the step being shown; null shows all at once. */
  activeStep: number | null;
}

export function CoachOverlay({ photo, steps, activeStep }: Props) {
  const raw = lastMeshPoints();
  const map = useMemo(() => {
    if (!raw || raw.length < 468) return null;
    try {
      const norm = normalizeFace(raw);
      if (!norm) return null;
      return { norm, cm: buildContourMap(norm) };
    } catch {
      // buildContourMap throws when a landmark the hull needs is missing.
      return null;
    }
  }, [raw]);

  if (!map || typeof photo !== "string" || photo.length === 0) {
    return (
      <div className="coach-overlay-empty">
        <p>Face map needs a frontal photo. Retake facing the mirror.</p>
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
  const shapes = [...cm.zones, ...cm.ribbons] as ZoneOrRibbon[];
  const shapeById = new Map(shapes.map((z) => [z.id, z]));
  const shown = activeStep === null ? steps : steps[activeStep] ? [steps[activeStep]!] : [];
  const { pigments, guides } = zoneLayers(shown, shapes, norm.iod, VB_W, activeStep === null);

  const pointsFor = (id: string): string | null => {
    const z = shapeById.get(id);
    if (!z) return null;
    return pointsAttr(z.poly.map((q) => {
      const f = toFrame(q);
      return { x: f.x * VB_W, y: f.y * VB_H };
    }));
  };

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="coach-overlay" role="img"
      aria-label="Face map showing where each step applies">
      <image href={photo} x={0} y={0} width={VB_W} height={VB_H} preserveAspectRatio="xMidYMid slice" />
      {pigments.map((p, i) => {
        const points = pointsFor(p.zoneId);
        if (!points) return null;
        return (
          <polygon key={`${p.zoneId}:${i}`} className="zone-pigment" data-zone={p.zoneId} data-blend={p.blend}
            points={points} fill={p.fill} fillOpacity={p.opacity}
            style={{ mixBlendMode: p.blend, filter: `blur(${p.sigma.toFixed(1)}px)` }} />
        );
      })}
      {guides.map((g) => {
        const points = pointsFor(g.zoneId);
        if (!points) return null;
        return (
          <polygon key={`guide:${g.zoneId}`} className="zone-guide" data-zone={g.zoneId}
            points={points} fill="none" stroke={g.stroke} strokeWidth={2.5} strokeOpacity={0.85} />
        );
      })}
    </svg>
  );
}
