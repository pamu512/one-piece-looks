/**
 * Coach overlay: where each step sits on the user's photo.
 *
 * Geometry is buildContourMap in the normalized frame, drawn back through
 * IOD and roll. Pigment polygons use the step shade, a blend mode, and a
 * gaussian feather (lib/coach/fill.ts); once the bisenet parse lands they
 * are additionally clipped by a soft mask (lib/coach/softMask.ts) so
 * pigment follows skin and stops at hair and background - the mask
 * carries the feather then, so the softness is not doubled. Guide strokes
 * are a second pass with no blend and no blur, so the annotation stays a
 * crisp vector. Paired zone stems (cheek_apple) resolve to the _L/_R
 * polygons.
 */

import { useEffect, useMemo, useState } from "react";
import { buildContourMap, type ZoneOrRibbon, type Pt } from "../lib/coach/zones.ts";
import { pointsAttr, zoneLayers } from "../lib/coach/fill.ts";
import { normalizeFace } from "../lib/coach/measure.ts";
import { lastMeshPoints } from "../lib/faceMesh.ts";
import { parseFacePhoto } from "../lib/faceParse.ts";
import { buildMaskKit, gateForZone, zoneMaskDataUrl, type MaskKit } from "../lib/coach/softMask.ts";
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

  // All hooks run before the empty-state return below; a null map keeps
  // them on empty inputs.
  const shapes = useMemo<ZoneOrRibbon[]>(
    () => (map ? [...map.cm.zones, ...map.cm.ribbons] : []),
    [map],
  );
  const shapeById = useMemo(() => new Map(shapes.map((z) => [z.id, z])), [shapes]);
  const shown = useMemo(
    () => (activeStep === null ? steps : steps[activeStep] ? [steps[activeStep]!] : []),
    [steps, activeStep],
  );
  const { pigments, guides } = useMemo(
    () => (map ? zoneLayers(shown, shapes, map.norm.iod, VB_W, activeStep === null) : { pigments: [], guides: [] }),
    [map, shown, shapes, activeStep],
  );

  // Soft masks (phase 2 step 3): one bisenet parse per photo, async.
  // Until it lands - or forever, if the model or runtime is unavailable -
  // the pigments render exactly as step 2 drew them.
  const [kit, setKit] = useState<MaskKit | null>(null);
  useEffect(() => {
    let on = true;
    setKit(null);
    parseFacePhoto(photo).then((planes) => {
      if (on && planes) setKit(buildMaskKit(planes));
    });
    return () => {
      on = false;
    };
  }, [photo]);

  // Inverse of normalizeFace's transform (rotate by -roll, scale by 1/iod):
  // scale back by iod, then rotate by +roll. Verified against the raw mesh:
  // cheek 205 at frame (0.228, 0.619) round-trips to (0.230, 0.618).
  const toFrame = useMemo(() => {
    if (!map) return null;
    const roll = (map.norm.rollDeg * Math.PI) / 180;
    const cos = Math.cos(roll);
    const sin = Math.sin(roll);
    const iod = map.norm.iod;
    return (q: Pt): Pt => {
      const sx = q.x * iod;
      const sy = q.y * iod;
      return { x: sx * cos - sy * sin, y: sx * sin + sy * cos };
    };
  }, [map]);

  // Aligned with `pigments` by index: null entries render unmasked.
  const masks = useMemo(() => {
    if (!kit || !toFrame) return null;
    return pigments.map((p, i) => {
      const shape = shapeById.get(p.zoneId);
      if (!shape) return null;
      const href = zoneMaskDataUrl(shape.poly.map(toFrame), p.sigma, kit, gateForZone(p.zoneId), VB_W);
      return href ? { id: `softmask-${i}-${p.zoneId}`, href } : null;
    });
  }, [pigments, shapeById, kit, toFrame]);

  if (!map || typeof photo !== "string" || photo.length === 0) {
    return (
      <div className="coach-overlay-empty">
        <p>Face map needs a frontal photo. Retake facing the mirror.</p>
      </div>
    );
  }

  const pointsFor = (id: string): string | null => {
    const z = shapeById.get(id);
    if (!z || !toFrame) return null;
    return pointsAttr(z.poly.map((q) => {
      const f = toFrame(q);
      return { x: f.x * VB_W, y: f.y * VB_H };
    }));
  };

  return (
    <svg viewBox={`0 0 ${VB_W} ${VB_H}`} className="coach-overlay" role="img"
      aria-label="Face map showing where each step applies">
      <image href={photo} x={0} y={0} width={VB_W} height={VB_H} preserveAspectRatio="xMidYMid slice" />
      <defs>
        {masks?.map((m) => m && (
          <mask key={m.id} id={m.id} maskUnits="userSpaceOnUse" x={0} y={0} width={VB_W} height={VB_H}>
            {/* 512-square mask stretched onto the 4:5 viewBox, matching the photo stretch */}
            <image href={m.href} x={0} y={0} width={VB_W} height={VB_H} preserveAspectRatio="none" />
          </mask>
        ))}
      </defs>
      {pigments.map((p, i) => {
        const points = pointsFor(p.zoneId);
        if (!points) return null;
        const m = masks?.[i];
        return (
          <polygon key={`${p.zoneId}:${i}`} className="zone-pigment" data-zone={p.zoneId} data-blend={p.blend}
            points={points} fill={p.fill} fillOpacity={p.opacity}
            mask={m ? `url(#${m.id})` : undefined}
            // The mask carries the feather when present; blur it too and the
            // sigma would apply twice.
            style={m
              ? { mixBlendMode: p.blend }
              : { mixBlendMode: p.blend, filter: `blur(${p.sigma.toFixed(1)}px)` }} />
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
