# One Piece Looks: hand-traced lip ground truth (2026-10-08)

In-repo copy (probe-grid masks + JSONs). The probe patch below is APPLIED in
`demos/probe-lip-align.mjs`; `LIPGT` defaults to this folder (`demos/lipgt`).
Source-resolution masks and review overlays stay in the original hand-off folder.

Ground-truth lip masks for the 7 faces used by `demos/probe-lip-align.mjs`,
meant to replace the redness-threshold reference (`mouthGroundTruth`).
The probe change from `probe-lip-align-handgt.diff` is applied (see top note).

## Files (per face id)

- `<id>.json`: polygons and metadata (see "JSON fields").
- `<id>-mask.png` (hand-off folder only): binary lip mask at SOURCE image resolution, 255 = lip
  (outer polygon minus inner mouth opening), 0 = not lip.
- `<id>-mask-probe500x625.png`: the same mask already mapped into the
  probe's 500x625 grid (the grid `planes()` produces). This is what the patch loads.
- `<id>-overlay.png` (hand-off folder only): review image, thin green outline on a zoomed mouth crop,
  plus a full-face thumbnail (yellow = region the probe pipeline keeps,
  blue = zoom box).
- `gt-contact-sheet.png` (hand-off folder only): all 7 zoomed overlays, labeled.
- `probe-lip-align-handgt.diff` (hand-off folder only): the probe patch, now applied.

## JSON fields

`image`, `repo_path`, `width`, `height`: the source fixture.
`outer`, `inner`: polygons in source px (`inner` = [] when the mouth is closed).
`mouth_open`, `notes`: per-face tracing notes and ambiguity.
`coord_convention`, `probe_transform` {x0, y0, k}: see below.
`outer_probe`, `inner_probe`: the polygons mapped into the 500x625 probe grid.
`probe_stats` {px, cx, cy, bbox}: lip pixel count, centroid, and bbox of the probe-space mask.
`src_stats.px`: lip pixel count at source resolution.
`vs_bisenet_draft` {iou, mean/max boundary dist px}: how far the final GT is from the BiSeNet draft.
`simplify`: polygon simplification epsilon and IoU against the unsimplified trace.

## Coordinate space

Polygons `outer` / `inner` are in source image pixels of the fixture file
(`repo_path`), pixel-center convention: (0,0) is the center of the top-left
pixel. A pixel is lip when its center is inside `outer` and outside `inner`
(the PNG masks use a 4x4 supersampled coverage >= 0.5, which is the same thing
up to edge pixels). `inner` is `[]` for closed mouths.

How the probe sees the image (read from the probe and apps/client, no mirroring anywhere):

1. Fake camera: center-crop the source to 3:4, draw to 480x640.
2. `cam.grab()` gives 480x640; `normalizeTo45` center-crops to 4:5
   (rows 20..620 of the 480x640 frame) and draws to 1000x1250.
3. The probe reads the bare 1000x1250 frame and ffmpeg-scales it to 500x625.

Net transform from source px (x, y) to probe px (X, Y), a uniform scale plus offset:

    X = (x + 0.5 - x0) * k - 0.5
    Y = (y + 0.5 - y0) * k - 0.5

with (x0, y0, k) stored per face in `probe_transform`. `outer_probe` / `inner_probe`
are the polygons already mapped. I checked the transform by simulating the
pipeline in PIL and overlaying the probe-space polygons (face-portrait checked
at 10x; the lips line up).

| face | repo path | source | mouth | outer pts | inner pts | x0, y0, k | probe lip px | probe centroid | IoU vs BiSeNet draft |
|---|---|---|---|---|---|---|---|---|---|
| face-live | apps/client/public/fixtures/face-portrait-live.jpg | 1350x1350 | open | 40 | 38 | 168.75, 42.1875, 0.493827 | 8470 | (244.59, 427.13) | 0.755 |
| face-portrait | apps/client/public/fixtures/face-portrait.jpg | 2700x1800 | open | 39 | 21 | 675.0, 56.25, 0.370370 | 1023 | (297.85, 216.27) | 0.949 |
| face-test | apps/server/fixtures/face-portrait-test.jpg | 640x427 | open | 36 | 21 | 159.875, 13.3438, 1.561280 | 1020 | (297.78, 216.28) | 0.828 |
| face-a-curly | demos/.mask-qa/faces/face-a-curly.png | 740x592 | open | 38 | 20 | 148.0, 18.5, 1.126126 | 6281 | (201.68, 438.94) | 0.954 |
| face-b-pulled-back | demos/.mask-qa/faces/face-b-pulled-back.png | 540x360 | closed | 36 | 0 | 135.0, 11.25, 1.851852 | 4032 | (270.62, 423.77) | 0.902 |
| face-c-blonde | demos/.mask-qa/faces/face-c-blonde.png | 1004x1326 | open | 35 | 24 | 4.75, 41.4375, 0.502765 | 3695 | (255.09, 373.35) | 0.929 |
| face-d-tan | demos/.mask-qa/faces/face-d-tan.png | 554x554 | closed | 40 | 0 | 69.25, 17.3125, 1.203369 | 2740 | (247.8, 394.59) | 0.903 |

## How to load

Probe-space mask (what the patch does), Node + ffmpeg (already a probe dependency):

```js
const r = spawnSync("ffmpeg", ["-y", "-i", `${LIPGT}/${id}-mask-probe500x625.png`,
  "-f", "rawvideo", "-pix_fmt", "gray", "/tmp/gt.gray"]);
const g = readFileSync("/tmp/gt.gray");           // 500*625 bytes
const mask = Uint8Array.from(g, (v) => (v >= 128 ? 1 : 0));
```

From JSON, without ffmpeg (rasterize at pixel centers, even-odd rule):

```js
const j = JSON.parse(readFileSync(`${LIPGT}/${id}.json`, "utf8"));
const inside = (poly, x, y) => { let c = false; for (let i = 0, k = poly.length - 1; i < poly.length; k = i++) {
  const [xi, yi] = poly[i], [xk, yk] = poly[k];
  if ((yi > y) !== (yk > y) && x < ((xk - xi) * (y - yi)) / (yk - yi) + xi) c = !c; } return c; };
const mask = new Uint8Array(500 * 625);
for (let y = 0; y < 625; y++) for (let x = 0; x < 500; x++)
  mask[y * 500 + x] = inside(j.outer_probe, x, y) && !(j.inner_probe.length && inside(j.inner_probe, x, y)) ? 1 : 0;
```

Python: `np.array(Image.open(f"{id}-mask.png")) > 0` (source res) or the
`-mask-probe500x625.png` file (probe res).

## Probe patch (applied)

`probe-lip-align-handgt.diff` (applied to `demos/probe-lip-align.mjs`, with `LIPGT`
now defaulting to `demos/lipgt`):

- Adds `handGroundTruth(id)`, which loads `<LIPGT>/<id>-mask-probe500x625.png`.
  `LIPGT` defaults to this folder. `LIPGT=off`, or a missing file, falls back to the old redness reference.
- `gt = hand ?? mouthGroundTruth(...)`; everything downstream (painted band,
  1 px erosion, IoU, coverage, centerErr, debug strip) is unchanged.
- Adds `gtSource` and `pass` to each results row, using the unchanged gate
  IoU >= 0.55 and centerErr <= 8 px. The current file only reports the metrics
  and never applies that gate itself, so the patch writes it down as constants
  (`IOU_MIN = 0.55`, `CENTER_MAX = 8`). If the gate lives in another runner, drop those two lines.
- I checked it with `node --check` and `patch --dry-run` against the file as of
  commit 9780b27 (branch feat/soft-lab-paint).

Note: the GT bbox still feeds the painted-region band (`markRect` around
gtBBox +-4 px), as before. With hand GT that band is now based on the
true lip extent.

## Method and per-face notes

The BiSeNet draft (zll-bisenet-512-int8 on a face crop; classes 11/12/13) was
only a starting point. I checked every polygon on 2x to 16x zoomed crops with
a coordinate ruler and corrected it, using local column and row profiles of
CIE L*, a*, b* to put each boundary point at the half-transition of the local
edge ramp. No global redness threshold or mask threshold was used anywhere.
On the low-contrast faces I also reviewed a contrast-stretched Lab view.
Polygons were finally simplified to 40 points or fewer (IoU vs unsimplified >= 0.997).

- **face-live** (open, outer 40 / inner 38 pts): Open smile, teeth visible. Source is a heavily upscaled, blurry JPEG: every lip edge is a soft ramp about 10 to 15 px wide at source resolution, so the boundary was put at the half-transition of each ramp (read from column profiles), and the realistic tolerance is about +-3 px (about +-1.5 px in probe space). Corrections to the BiSeNet draft were large: inner top edge moved down about 8 to 12 px (the draft counted the shaded lower half of the upper lip as mouth); lower lip bottom raised about 5 to 12 px at x 620 to 760 (the draft followed the chin shadow below the lip); outer top moved 1 to 4 px; both commissures re-placed; dark corner (buccal) areas treated as mouth opening. Draft IoU vs final 0.755, mean boundary shift 5.1 px. Ambiguous: inner top edge (shadowed lipstick vs mouth cavity), lower lip bottom around x 690 to 720, and the dark commissure regions.
- **face-portrait** (open, outer 39 / inner 21 pts): Open smile, teeth visible. Sharp image, clear lipstick edges. The BiSeNet draft was already good: outer top replaced by measured column half-transitions (changes of 2 px or less, cupid's bow peaks at x 1458 and 1512, dip at x 1494), lower lip and inner edges checked point by point and kept within about 1 px, inner right corner extended about 4 px into the dark buccal corner. Draft IoU vs final 0.949, mean boundary shift 0.4 px. Note: the mouth covers only about 1000 px in probe space (k=0.37).
- **face-test** (open, outer 36 / inner 21 pts): Same photo as face-portrait, downscaled exactly to 640x427 (resizing face-portrait with Lanczos matches it with zero sub-pixel shift). Polygons are the face-portrait final scaled with the pixel-center convention (x' = (x+0.5)*640/2700 - 0.5, y' = (y+0.5)*427/1800 - 0.5), then checked visually at 16x zoom. The mouth is only about 47x18 px here, so 1 px is a large fraction of lip thickness. BiSeNet on this small image was noticeably worse (draft IoU 0.828).
- **face-a-curly** (open, outer 38 / inner 20 pts): Lips slightly parted: teeth and a dark gap show in a 3 to 6 px slit at x 300 to 350, traced as the inner polygon. Very glossy lips with big specular highlights; the outer border sits on the outer edge of the pale vermillion rim highlight (the skin side of the rim). The draft outer was within about 1 to 2 px (upper left moved out about 1 px, right side about 1 to 2 px); the draft inner was only a fragment in the wrong place, so it was redrawn from scratch using the teeth (low a*) and dark-gap (low L) pixels. Ambiguous: the cupid's bow dip near x 328 (a dark philtrum shadow merges with the lip edge), about +-2 px.
- **face-b-pulled-back** (closed, outer 36 / inner 0 pts): Closed mouth; the dark line between the lips is the lip seam and counts as lip. The draft was an integer staircase and slightly tight. Top edge refined to the a* half-transition (cupid's bow dip added at x 280, y 229.8), lower lip bottom moved down about 1 to 2 px, commissures placed on the dark corner tips (250.3, 235.8) and (313, 235.3). Draft IoU vs final 0.902, mean boundary shift 0.7 px. Lip edges are clear; tolerance about +-1 px.
- **face-c-blonde** (open, outer 35 / inner 24 pts): Lips slightly parted: teeth visible in a small gap at x 494 to 531, y 776 to 789 (inner polygon). Pale, low-contrast lips on fair skin, face tilted about 5 degrees (right corner higher). Corrections: lower lip bottom moved down 2 to 6 px (left and center) to where the a* drop and the L rise agree; upper-left top raised 2 to 3 px as a compromise between an early, gradual a* rise and the later L drop; right commissure extended into the dark corner (622, 764); inner polygon redrawn from teeth (low b*) and dark-gap pixels. Draft IoU vs final 0.929, mean boundary shift 1.6 px. GENUINELY AMBIGUOUS: the upper-left and lower-left lip borders (about +-4 px); the right half and the top center are clearer (+-2 px).
- **face-d-tan** (closed, outer 40 / inner 0 pts): Closed mouth; the lower lip has strong vertical texture lines that are lip, not teeth. The draft was an integer staircase. Top edge refined to the L half-transition (cupid's bow peaks at x 266 and 286, y about 329; dip at x 274, y 331.2); bottom placed at the a* half-transition just above the dark shadow under the lower lip (y about 362.5 at the center); commissures at (234.5, 340.2) and (314.5, 339.5); the dark crease beyond the corners is skin and is excluded. Draft IoU vs final 0.903, mean boundary shift 0.9 px.

Genuinely ambiguous edges: face-c-blonde upper-left and lower-left border
(about +-4 px source, +-2 px probe); face-live inner top edge and lower lip
bottom near the center (soft, blurred ramps, about +-3 px source); face-a-curly
cupid's bow dip (+-2 px). On face-portrait the mouth is small in probe space
(about 1000 px), so a 1 px probe-space error costs more IoU there than on the
other faces.
