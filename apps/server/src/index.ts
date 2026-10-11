/**
 * Fastify entrypoint. Binds localhost by default (LAN-expose via HOST=0.0.0.0
 * for phone testing). No disk persistence of photos, ever.
 */

import Fastify from "fastify";
import cors from "@fastify/cors";
import { registerRoutes } from "./api/routes.js";
import { store } from "./session/store.js";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8787);
const clientOrigin = process.env.CLIENT_ORIGIN ?? "http://localhost:5173";
const rendersBudget = Number(process.env.RENDER_BUDGET ?? 9);
const mock = process.env.YOUCAM_MOCK === "1" || !process.env.YOUCAM_API_KEY;
const apiKey = process.env.YOUCAM_API_KEY || undefined;
const baseUrl = process.env.YOUCAM_BASE_URL || "https://yce-api-01.makeupar.com";
const demoToken = process.env.DEMO_TOKEN || undefined;

const app = Fastify({
  logger: true,
  bodyLimit: 20 * 1024 * 1024, // 20MB: base64 face JPEG headroom
});

await app.register(cors, {
  origin: [clientOrigin, "http://localhost:5173", "http://127.0.0.1:5173"],
});

registerRoutes(app, { apiKey, baseUrl, rendersBudget, mock, demoToken });

app.get("/health", async () => ({ ok: true, mock, budget: rendersBudget }));

// Evict expired sessions on a timer, not just lazily on create().
store.startSweeper();

app.listen({ port, host }).then(
  () => {
    app.log.info(`One Piece Looks server on http://${host}:${port} (mock=${mock})`);
  },
  (err) => {
    app.log.error(err);
    process.exit(1);
  },
);
