# Beauty-cam mock demo (2026-10-06 HKT, re-record)

- Commits on main: through a7ce930 (mock look contrast + bare-hold; Soft x Casual looks apart on a light face)
- Face: demos/.mask-qa/faces/face-c-blonde.png (lighter PASS face)
- MP4: demos/opl-beauty-cam-demo-20261006.mp4
- Recorder: demos/record-beauty-cam-demo-20261006.mjs
- Probes: demos/probe-look-distinct.mjs (API, 10/10), demos/probe-ui-distinct.mjs (UI, 6/6)
- Evidence: demos/look-distinct-evidence-20261006.json
- Servers: YOUCAM_MOCK=1 mock:true on :8787; Vite :5173
- Root causes fixed: lookIn CSS animation fill both kept the bare overlay on every look; soft-light support layers at low opacity were invisible after video compression
- Anchor < Lift < Statement frame diffs (face band, mean luma delta vs bare): 1.85 < 4.27 < 9.77
- Hold-to-compare shows the bare photo (worn hidden, pill "Your face")
- Lock hex #b3122e identical on all three looks and after shuffle (PROVE_OK)
- Not uploaded to YouTube or Devpost. No Final Submit.

## YouTube upload (manual)
1. YouTube Studio -> Upload demos/opl-beauty-cam-demo-20261006.mp4
2. Title: Sculpt - one lip, three looks (mock, light skin)
3. Paste public/unlisted URL into Devpost draft gallery only. Do not Final Submit.
