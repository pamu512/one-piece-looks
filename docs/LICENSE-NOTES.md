# License notes

Application code is under the MIT License in the repository root
([LICENSE](../LICENSE)), copyright 2026 Anoop Pamu.

That grant does not relicense the third-party components below. Their
original terms stay in force, including the BiSeNet face-parsing weights.

## MediaPipe Face Landmarker

`apps/client/public/models/face_landmarker.task` is Google's MediaPipe face
landmarker (float16). MediaPipe is Apache-2.0. The wasm runtime files under
`apps/client/public/mediapipe/wasm/` are a committed copy of the wasm from
`@mediapipe/tasks-vision`, the package the app depends on. Installing a
newer release of that package does not refresh these files.

This is the primary geometry path: lip ring, mouth hole, eye rings, brow
arcs, face oval, cheek anchors.

## Detection ladder

1. MediaPipe 478-point mesh (Apache-2.0) - primary.
2. YOLO face-frame detector (`face-frame.onnx`, trained in-repo on WIDER
   selfie-biased subset) - box only, refines the mesh fallback path.
3. Redness-heuristic lip + skin-grid box - dependency-free floor, no model.

## BiSeNet face-parsing weights

`apps/client/public/models/zll-bisenet-512-int8.onnx` is the zll-bisenet
resnet18 face parser (int8 ONNX, 19 classes), trained on CelebAMask-HQ
via face-makeup.PyTorch's released checkpoint `cp/79999_iter.pth`. The
CelebAMask-HQ dataset agreement is non-commercial research only, so these
weights carry that restriction with them.

History: shipped once, then removed 2026-10-09 (commit fa8099f) as a
non-commercial artifact; re-added 2026-10-25 for the coach face map's
soft pigment masks (plan phase 2 step 3) - a recorded decision to accept
the restriction for this project. If that no longer holds, delete the
model and the face map falls back to its polygon fills automatically;
`lib/faceParse.ts`, `lib/coach/softMask.ts`, and their tests go with it.
