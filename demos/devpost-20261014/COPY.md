# Devpost copy pack: Sculpt (draft only)

Do **not** Final Submit from this pack. Paste into the existing Devpost draft (was 2/5). Deadline ~2026-11-03. ReadyPup = under-sell caution.

## One-line outcome pitch (above the fold)

**One lipstick on your face → three looks that keep that color.**

Alt (UI headline, also fine): **One piece. Three looks.**

## Short product-first blurb (About / Elevator)

Sculpt locks the lipstick color as it sits on your face, then builds three wearable looks around it: Anchor, Lift, and Statement. The coach reads your face shape, walks Shade → Blush → Light with live sweeps, and Calibrate 3D so placement stays true when you turn. Phone-first web app; YouCam powers the try-on analysis. No account wall in the demo path. This is a free demo, with no IAP.

## Built with (chips)

YouCam · React · Vite · Fastify · MediaPipe · TypeScript

## Try it out

**Live (mock YouCam):** https://one-piece-looks-668862805115.us-central1.run.app

Alt: https://one-piece-looks-ix6tr5hr7a-uc.a.run.app

Paste the primary URL into Devpost Try it out. Mock mode (`YOUCAM_MOCK=1`); no API keys on the host. Same origin serves UI + `/api`. Deploy notes: `~/.config/ax/inbox/opl-tryit-deploy-20261014.md`. Rebuild commit on `origin/main`: `9495711` (pack assets still from `508da2a` gallery).

Repo: https://github.com/pamu512/one-piece-looks (private). No store listing.

### Local fallback

```bash
git clone https://github.com/pamu512/one-piece-looks.git
cd one-piece-looks && npm install
cp .env.example .env   # leave key unset OR set YOUCAM_MOCK=1
npm run dev:server     # http://127.0.0.1:8787  (mock if no key)
npm run dev -w apps/client   # http://127.0.0.1:5173
```

Do **not** put localhost, ngrok, or “coming soon” in Try it out when the live URL above works.

## Hero / YouTube

| Asset | Path | Status |
|-------|------|--------|
| Demo MP4 (~29s, under 60s) | `hero/opl-beauty-cam-demo-20261006.mp4` | Ready; **not on YouTube yet** |
| Product poster (looks UI) | `hero/youtube-poster-product.png` | Ready for Studio custom thumbnail |
| Capture poster (live shutter) | `hero/youtube-poster-capture.png` | Alternate thumbnail |

**Upload steps (manual):** YouTube Studio, upload the MP4, use the paste block below, custom thumbnail from the product poster, unlisted or public, then paste the URL into the Devpost gallery. Not on YouTube yet. Do not Final Submit.

## YouTube paste block (manual)

Title: Sculpt: one lip, three looks

Description: One lipstick on your face, then three looks that keep that color. The live coach walks Shade, Blush, and Light, then Calibrate 3D. Free demo, no IAP.

Hashtags: #Sculpt #lipstick #facecoach

Upload state: not on YouTube yet. Anoop uploads this in YouTube Studio. Do not Final Submit.

**Caveat:** This hero covers the beauty-cam / three-looks loop (mock light face). It does not yet show Teach me / Calibrate 3D / P2 overlay. Stills 05–10 cover that in the gallery. Optional re-record script: `HERO-CAPTURE-SCRIPT.md`.

## Soft lipstick

Not in this pack. Do not implement unless `ax decide` says so.
