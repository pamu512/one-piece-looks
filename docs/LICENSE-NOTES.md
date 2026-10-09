# License notes

## MediaPipe Face Landmarker

`apps/client/public/models/face_landmarker.task` is Google's MediaPipe face
landmarker (float16). MediaPipe is Apache-2.0. The wasm runtime files under
`apps/client/public/mediapipe/wasm/` come from the `@mediapipe/tasks-vision`
npm package the app depends on, so their version always matches the JS bundle.

This is the primary geometry path: lip ring, mouth hole, eye rings, brow
arcs, face oval, cheek anchors.

## Detection ladder

1. MediaPipe 478-point mesh (Apache-2.0) - primary.
2. YOLO face-frame detector (`face-frame.onnx`, trained in-repo on WIDER
   selfie-biased subset) - box only, refines the mesh fallback path.
3. Redness-heuristic lip + skin-grid box - dependency-free floor, no model.

## BiSeNet face-parsing weights (REMOVED 2026-10-09)

The app previously shipped `face-parse-bisenet-512-int8.onnx` (BiSeNet
weights trained on CelebAMask-HQ). That dataset agreement is non-commercial
research only. The MediaPipe mesh supersedes it on every probed face, so the
weights, the parser module, and its tests were removed. They survive in git
history (commit 37390b2 and earlier) if they are ever needed for a
non-commercial context.
