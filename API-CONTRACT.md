# One Piece Looks - Client/Server Contract

Server (this repo, apps/server) is the ONLY YouCam caller. The client (apps/client, built by Autoclaw) owns capture, sampling, gates, and all six screens.

- Base URL dev: http://127.0.0.1:8787
- All bodies JSON. Errors: `{ "error": string, "code": string, "retryable": boolean }`.
- `mock: true` in responses means the server has no YouCam key; shapes are identical either way.

## Flow

```
POST /api/session                       -> { sessionId, rendersBudget, mock }
POST /api/session/:id/face              -> skin type + tone (one HD pass, retakes idempotent)
POST /api/session/:id/tone              -> picker fallback when toneFallback=true
POST /api/session/:id/looks             -> exactly 3 looks (mood+event REQUIRED, no defaults)
POST /api/session/:id/shuffle           -> re-roll supports only; lock/mood/event stay
GET  /api/session/:id                   -> summary (for resume-after-error; no photos)
```

## POST /api/session/:id/face

Request:
```json
{
  "faceImageBase64": "<base64 JPEG, short side >= 1080 for HD skin analysis>",
  "lock": {
    "category": "lip" | "cheek" | "eye" | "brow" | "liner",
    "onFaceHex": "#rrggbb",
    "productHex": "#rrggbb",
    "unverified": false
  }
}
```
- Client samples both hexes (canvas) BEFORE this call. onFaceHex is the lock.
- `unverified: true` when the user hit "Continue anyway" after 3 retake nudges.
- Same photo re-posted = idempotent, analysis never re-runs (server enforces).

Response:
```json
{
  "sessionId": "...",
  "skinType": "Normal" | "Oily" | "Dry" | "Combination" | "Redness" | "Dry & Redness" | "Oily & Redness" | "Combination & Redness",
  "toneFallback": false,
  "tone": { "source": "api", "skinColor": "#c28e6b" },
  "toneHex": "#c28e6b"
}
```
- `toneFallback: true` -> show the tone picker (six depths 01-06, warm/neutral/cool, two taps), then POST /tone.
- Skin type facts row copy: NEVER name a skin condition. Use "skin type: Combination" style phrasing only.
- 422 `face` code: photo unreadable -> retake guidance, not a dead end.

## POST /api/session/:id/tone
`{ "depth": "01".."06", "temperature": "warm"|"neutral"|"cool" }` -> `{ sessionId, tone }`

## POST /api/session/:id/looks
Request: `{ "mood": "<one of 8>", "event": "<one of 8>", "tone"? : {depth, temperature} }`
- 400 `mood_event_required` if either missing. No defaults, ever.
- Moods: Bitch mode, Boss, Demure, Owning it, Sexy, Soft, Clean, Main character.
- Events: Dinner date, Office, Casual, Workout, Night out, Wedding guest, Errands, Interview.

Response:
```json
{
  "sessionId": "...",
  "looks": [
    { "role": "anchor",    "imageUrl": "...", "chips": [{ "label": "Lip", "detail": "red - locked", "hex": "#b3122e" }, ...], "shop?": {...}, "lockApproximated": false },
    { "role": "lift",      "...": "locked piece + 1-2 harmonized layers" },
    { "role": "statement", "...": "locked piece + full pattern set" }
  ],
  "rendersLeft": 6,
  "lockApproximated": false
}
```
- Roles are ALWAYS exactly these three, in this order. Names in UI: Anchor, Lift, Statement.
- First chip of every look is the locked piece with the exact on-face hex.
- `lockApproximated: true` would mean the render used the nearest named shade (fallback); keep the on-face swatch visible with "your shade reads closest to this". (Not expected: makeup-vto takes arbitrary hex.)
- Budget: default 9 renders = first build (3) + two shuffles/rebuilds (3+3). 429 `budget_exhausted` after that; offer "Change mood/event" (still costs 3) or "Start over".
- Empty state: three skeletons, lock chip colored with the lock hex, from the moment the request is in flight.

## POST /api/session/:id/shuffle
No body. Lock, mood, event unchanged; supporting layers re-rolled. Response same shape as /looks.

## Error policy (client)
- Retry ONCE on `retryable: true` (network/timeout/5xx), then the calm card.
- Photos and lock survive errors (keep in memory; re-POST face is idempotent).
- Loading copy follows real phases: "Sampling your color" (client-side), "Reading your skin type" (face call in flight), "Building your three looks" (/looks in flight).

## Privacy footer copy (Start screen)
"Photos go to the YouCam service for analysis. We don't keep them." No accounts.

## Canned-input path
If live capture fails on demo day, bundled sample INPUT photos may be sent through the live API (they are inputs, clearly marked). Never show canned OUTPUTS.

## Server env
See .env.example. `YOUCAM_API_KEY` set -> live mode. Unset -> deterministic mock (same contract, SVG placeholder renders labeled "mock").
