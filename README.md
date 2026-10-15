# Sculpt

One product photo plus one face photo produces Anchor, Lift, and Statement:
three looks locked to the lipstick color that lands on that face. Phone-first
web app.

The Fastify server (`apps/server`) is the only YouCam caller. The Vite client
(`apps/client`) never sees the API key.

- `apps/server` - Fastify, the only YouCam caller. Session contract in
  [API-CONTRACT.md](API-CONTRACT.md). TypeScript, strict, vitest.
- `apps/client` - Vite + React client (six screens).

## Run

Requires Node `>=22`.

```
npm install
cp .env.example .env    # then fill in your YouCam keys
npm run dev:server      # http://127.0.0.1:8787
npm run dev -w apps/client
```

## Test

```
npm test
npm run prove:lipstick
```

## Mock mode

Set `YOUCAM_MOCK=1` or leave the key unset: the server runs a deterministic
mock and makes no network calls.

## Fixtures

- [apps/server/fixtures/ATTRIBUTION.md](apps/server/fixtures/ATTRIBUTION.md)
- [apps/client/public/fixtures/ATTRIBUTION.md](apps/client/public/fixtures/ATTRIBUTION.md)
