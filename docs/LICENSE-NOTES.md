# License notes

## BiSeNet face-parsing weights

`apps/client/public/models/face-parse-bisenet-512-int8.onnx` is an int8 export of the BiSeNet weights from [zllrunning/face-parsing.PyTorch](https://github.com/zllrunning/face-parsing.PyTorch). The code in that repository is MIT. The weights are trained on [CelebAMask-HQ](https://github.com/switchablenorms/CelebAMask-HQ). That dataset agreement is non-commercial research only, and the limit covers derived data and derived weights.

These weights are fine for the hackathon judging demo. They are not cleared for commercial use.

The license-clean geometry path, as a later step, is MediaPipe Face Landmarker. Until then, if the ONNX model fails to load, errors, or returns an implausible lip area, the app keeps the redness heuristic for the lip polygon. That heuristic does not use the CelebAMask-HQ weights.
