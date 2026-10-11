import { describe, it, expect, beforeEach } from "vitest";
import Fastify from "fastify";
import { registerRoutes } from "./routes.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const FIXTURE_FACE = join(dirname(fileURLToPath(import.meta.url)), "../../fixtures/face-portrait-test.jpg");

// Force mock mode for contract tests.
const cfg = { baseUrl: "https://example.test", rendersBudget: 9, mock: true };

function makeApp() {
  const app = Fastify({ bodyLimit: 20 * 1024 * 1024 });
  registerRoutes(app, cfg);
  return app;
}

const FACE_B64 = readFileSync(FIXTURE_FACE).toString("base64"); // real JPEG fixture
const LOCK = {
  category: "lip",
  onFaceHex: "#B3122E",
  productHex: "#C01830",
  unverified: false,
} as const;

async function makeSession(app: ReturnType<typeof makeApp>) {
  const res = await app.inject({ method: "POST", url: "/api/session" });
  expect(res.statusCode).toBe(200);
  return res.json<{ sessionId: string }>();
}

async function runFace(
  app: ReturnType<typeof makeApp>,
  id: string,
  lock: unknown = LOCK,
) {
  return app.inject({
    method: "POST",
    url: `/api/session/${id}/face`,
    payload: { faceImageBase64: FACE_B64, lock },
  });
}

async function readySession(app: ReturnType<typeof makeApp>) {
  const { sessionId } = await makeSession(app);
  const face = await runFace(app, sessionId);
  expect(face.statusCode).toBe(200);
  return sessionId;
}

describe("session lifecycle", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("creates a session with a budget", async () => {
    const res = await app.inject({ method: "POST", url: "/api/session" });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ sessionId: string; rendersBudget: number; mock: boolean }>();
    expect(body.sessionId).toHaveLength(36);
    expect(body.rendersBudget).toBe(9);
    expect(body.mock).toBe(true);
  });

  it("404s unknown session", async () => {
    const res = await app.inject({ method: "GET", url: "/api/session/nope" });
    expect(res.statusCode).toBe(404);
  });
});

describe("face analysis", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("rejects missing image", async () => {
    const { sessionId } = await makeSession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/face`,
      payload: { lock: LOCK },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("bad_image");
  });

  it("runs skin type and tone, returns both", async () => {
    const { sessionId } = await makeSession(app);
    const res = await runFace(app, sessionId);
    expect(res.statusCode).toBe(200);
    const body = res.json<{ skinType?: string; toneFallback: boolean; tone?: { skinColor: string } }>();
    expect(body.skinType).toBeDefined();
    expect(body.toneFallback).toBe(false);
    expect(body.tone?.skinColor).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("retake (same image) does not re-run analysis: idempotent result", async () => {
    const { sessionId } = await makeSession(app);
    const first = await runFace(app, sessionId);
    const second = await runFace(app, sessionId);
    expect(second.statusCode).toBe(200);
    expect(first.json<{ skinType?: string }>().skinType).toBe(
      second.json<{ skinType?: string }>().skinType,
    );
  });

  it("rejects a bad lock hex", async () => {
    const { sessionId } = await makeSession(app);
    const res = await runFace(app, sessionId, {
      category: "lip",
      onFaceHex: "red",
      productHex: "#c01830",
      unverified: false,
    });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe("bad_lock");
  });

  it("keeps lipMeanL inside 0..100 and drops a value outside that range", async () => {
    async function statementSvg(lipMeanL: number): Promise<string> {
      const app = makeApp();
      const { sessionId } = await makeSession(app);
      const face = await app.inject({
        method: "POST",
        url: `/api/session/${sessionId}/face`,
        payload: { faceImageBase64: FACE_B64, lock: LOCK, landmarks: { lipMeanL } },
      });
      expect(face.statusCode).toBe(200);
      const looks = await app.inject({
        method: "POST",
        url: `/api/session/${sessionId}/looks`,
        payload: { mood: "Boss", event: "Office" },
      });
      expect(looks.statusCode).toBe(200);
      const body = looks.json<{ looks: { role: string; imageUrl: string }[] }>();
      const statement = body.looks.find((l) => l.role === "statement");
      expect(statement).toBeTruthy();
      return Buffer.from(statement!.imageUrl.split(",")[1]!, "base64").toString("utf8");
    }
    expect(await statementSvg(70)).toContain('data-lmean="70.00"');
    expect(await statementSvg(100)).toContain('data-lmean="100.00"');
    expect(await statementSvg(0)).toContain('data-lmean="0.00"');
    expect(await statementSvg(140)).not.toContain("data-lmean=");
  });

  it("keeps lipMeanA and lipMeanB inside -128..127 and drops a value outside that range", async () => {
    async function statementSvg(lipMeanA: number, lipMeanB: number): Promise<string> {
      const app = makeApp();
      const { sessionId } = await makeSession(app);
      const face = await app.inject({
        method: "POST",
        url: `/api/session/${sessionId}/face`,
        payload: {
          faceImageBase64: FACE_B64,
          lock: LOCK,
          landmarks: { lipMeanL: 40, lipMeanA, lipMeanB },
        },
      });
      expect(face.statusCode).toBe(200);
      const looks = await app.inject({
        method: "POST",
        url: `/api/session/${sessionId}/looks`,
        payload: { mood: "Boss", event: "Office" },
      });
      expect(looks.statusCode).toBe(200);
      const body = looks.json<{ looks: { role: string; imageUrl: string }[] }>();
      const statement = body.looks.find((l) => l.role === "statement");
      expect(statement).toBeTruthy();
      return Buffer.from(statement!.imageUrl.split(",")[1]!, "base64").toString("utf8");
    }
    const kept = await statementSvg(60, -20);
    expect(kept).toContain('data-amean="60.00"');
    expect(kept).toContain('data-bmean="-20.00"');
    expect(kept).toContain('data-lmean="40.00"');
    const ends = await statementSvg(-128, 127);
    expect(ends).toContain('data-amean="-128.00"');
    expect(ends).toContain('data-bmean="127.00"');
    const highA = await statementSvg(128, 10);
    expect(highA).not.toContain("data-amean=");
    expect(highA).toContain('data-lmean="40.00"');
    expect(highA).toContain('mode="color"');
    expect(highA).not.toContain('data-shift="1.00"');
    const lowB = await statementSvg(10, -129);
    expect(lowB).not.toContain("data-bmean=");
    expect(lowB).toContain('mode="color"');
  });

  it("keeps a skin polygon and the straight lip shift", async () => {
    const app = makeApp();
    const { sessionId } = await makeSession(app);
    const skin = [[0.3, 0.2], [0.7, 0.2], [0.72, 0.8], [0.28, 0.82]];
    const face = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/face`,
      payload: {
        faceImageBase64: FACE_B64,
        lock: LOCK,
        landmarks: {
          lipMeanL: 46, lipMeanA: 30, lipMeanB: 16,
          skin,
        },
      },
    });
    expect(face.statusCode).toBe(200);
    const looks = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Boss", event: "Office" },
    });
    expect(looks.statusCode).toBe(200);
    const body = looks.json<{ looks: { role: string; imageUrl: string }[] }>();
    const statement = body.looks.find((l) => l.role === "statement");
    expect(statement).toBeTruthy();
    const svg = Buffer.from(statement!.imageUrl.split(",")[1]!, "base64").toString("utf8");
    expect(svg).toContain('data-skin="1"');
    expect(svg).toContain("300.0,250.0");
    expect(svg).toContain('data-shift="1.00"');
  });

  it("rejects a bad category", async () => {
    const { sessionId } = await makeSession(app);
    const res = await runFace(app, sessionId, {
      category: "nails",
      onFaceHex: "#b3122e",
      productHex: "#c01830",
      unverified: false,
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("looks build", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("requires mood AND event (no defaults)", async () => {
    const sessionId = await readySession(app);
    const noMood = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { event: "Office" },
    });
    expect(noMood.statusCode).toBe(400);
    expect(noMood.json<{ code: string }>().code).toBe("mood_event_required");

    const noEvent = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Boss" },
    });
    expect(noEvent.statusCode).toBe(400);
  });

  it("rejects unknown mood/event values", async () => {
    const sessionId = await readySession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Vibing", event: "Office" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("returns exactly three looks with roles in order", async () => {
    const sessionId = await readySession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Boss", event: "Office" },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      looks: { role: string; imageUrl: string; chips: { label: string; hex: string }[] }[];
      rendersLeft: number;
    }>();
    expect(body.looks.map((l) => l.role)).toEqual(["anchor", "lift", "statement"]);
    expect(body.rendersLeft).toBe(6);
    for (const look of body.looks) {
      expect(look.imageUrl.startsWith("data:image/svg+xml")).toBe(true);
      expect(look.chips[0]!.hex).toBe("#b3122e");
    }
  });

  it("409 before face analysis", async () => {
    const { sessionId } = await makeSession(app);
    const res = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Boss", event: "Office" },
    });
    expect(res.statusCode).toBe(409);
  });
});

describe("shuffle + budget", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("shuffle re-rolls supports, keeps lock/mood/event, draws from the same budget", async () => {
    const sessionId = await readySession(app);
    const build = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual" },
    });
    const first = build.json<{ looks: { chips: { hex: string }[]; imageUrl: string }[]; rendersLeft: number }>();
    expect(first.rendersLeft).toBe(6);

    const shuffle = await app.inject({ method: "POST", url: `/api/session/${sessionId}/shuffle` });
    expect(shuffle.statusCode).toBe(200);
    const second = shuffle.json<{ looks: { chips: { hex: string }[]; imageUrl: string }[]; rendersLeft: number }>();
    expect(second.rendersLeft).toBe(3);
    // lock stays
    for (const look of second.looks) expect(look.chips[0]!.hex).toBe("#b3122e");
    // supports moved (at least one imageUrl changed)
    const changed = second.looks.some((l, i) => l.imageUrl !== first.looks[i]!.imageUrl);
    expect(changed).toBe(true);
  });

  it("budget exhausts after build + two shuffles", async () => {
    const sessionId = await readySession(app);
    await app.inject({ method: "POST", url: `/api/session/${sessionId}/looks`, payload: { mood: "Boss", event: "Office" } });
    await app.inject({ method: "POST", url: `/api/session/${sessionId}/shuffle` });
    await app.inject({ method: "POST", url: `/api/session/${sessionId}/shuffle` });
    const third = await app.inject({ method: "POST", url: `/api/session/${sessionId}/shuffle` });
    expect(third.statusCode).toBe(429);
    expect(third.json<{ code: string }>().code).toBe("budget_exhausted");
  });

  it("mood/event change rebuilds draw from the same budget", async () => {
    const sessionId = await readySession(app);
    await app.inject({ method: "POST", url: `/api/session/${sessionId}/looks`, payload: { mood: "Boss", event: "Office" } });
    const rebuild = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Sexy", event: "Night out" },
    });
    expect(rebuild.statusCode).toBe(200);
    expect(rebuild.json<{ rendersLeft: number }>().rendersLeft).toBe(3);
  });
});

describe("tone fallback picker", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("accepts a picker tone and then builds", async () => {
    const { sessionId } = await makeSession(app);
    await runFace(app, sessionId);
    const tone = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/tone`,
      payload: { depth: "04", temperature: "warm" },
    });
    expect(tone.statusCode).toBe(200);
    const build = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Clean", event: "Errands" },
    });
    expect(build.statusCode).toBe(200);
    expect(build.json<{ looks: unknown[] }>().looks).toHaveLength(3);
  });

  it("rejects a bad depth", async () => {
    const { sessionId } = await makeSession(app);
    await runFace(app, sessionId);
    const res = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/tone`,
      payload: { depth: "9", temperature: "warm" },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe("money safety (review 2026-10-10)", () => {
  let app: ReturnType<typeof makeApp>;
  beforeEach(() => {
    app = makeApp();
  });

  it("same idemKey replays the stored result without spending budget again", async () => {
    const sessionId = await readySession(app);
    const first = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual", idemKey: "retry-demo-0001" },
    });
    expect(first.statusCode).toBe(200);
    const firstJson = first.json<{ looks: { imageUrl: string }[]; rendersLeft: number }>();
    expect(firstJson.rendersLeft).toBe(6);

    // The lost-response retry: same intent, same key.
    const retry = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual", idemKey: "retry-demo-0001" },
    });
    expect(retry.statusCode).toBe(200);
    const retryJson = retry.json<{ looks: { imageUrl: string }[]; rendersLeft: number }>();
    expect(retryJson.rendersLeft).toBe(6); // NOT 3 — no re-spend
    expect(retryJson.looks.map((l) => l.imageUrl)).toEqual(firstJson.looks.map((l) => l.imageUrl));
  });

  it("a DIFFERENT idemKey is a new intent and spends normally", async () => {
    const sessionId = await readySession(app);
    await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual", idemKey: "intent-one-00001" },
    });
    const second = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual", idemKey: "intent-two-00002" },
    });
    expect(second.statusCode).toBe(200);
    expect(second.json<{ rendersLeft: number }>().rendersLeft).toBe(3);
  });

  it("concurrent builds cannot both pass the budget check (reserve-then-render)", async () => {
    const tightApp = Fastify({ bodyLimit: 20 * 1024 * 1024 });
    registerRoutes(tightApp, { ...cfg, rendersBudget: 6 });
    const sessionId = await readySession(tightApp);
    // Budget 6 fits exactly two builds of 3; a third would need 9. Under the
    // old check-then-await all three could pass against stale rendersUsed
    // and render 9 on a 6 budget. Reserve-then-render must cap at two.
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        tightApp.inject({
          method: "POST",
          url: `/api/session/${sessionId}/looks`,
          payload: { mood: "Soft", event: "Casual", idemKey: `race-key-${n}-00000` },
        }),
      ),
    );
    const oks = results.filter((r) => r.statusCode === 200);
    const exhausted = results.filter((r) => r.statusCode === 429);
    expect(oks.length).toBe(2);
    expect(exhausted.length).toBe(1);
    const left = oks.map((r) => r.json<{ rendersLeft: number }>().rendersLeft).sort();
    expect(left).toEqual([0, 3]);
  });

  it("shuffle retry with the same idemKey replays without spending", async () => {
    const sessionId = await readySession(app);
    await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Soft", event: "Casual", idemKey: "build-key-000001" },
    });
    const sh1 = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/shuffle`,
      payload: { idemKey: "shuffle-key-000001" },
    });
    expect(sh1.statusCode).toBe(200);
    expect(sh1.json<{ rendersLeft: number }>().rendersLeft).toBe(3);
    const sh2 = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/shuffle`,
      payload: { idemKey: "shuffle-key-000001" },
    });
    expect(sh2.statusCode).toBe(200);
    expect(sh2.json<{ rendersLeft: number }>().rendersLeft).toBe(3); // no re-spend
  });

  it("demo token rejects requests without it and accepts the right one", async () => {
    const tokened = Fastify({ bodyLimit: 20 * 1024 * 1024 });
    registerRoutes(tokened, { ...cfg, demoToken: "sesame-day-token" });
    const bare = await tokened.inject({ method: "POST", url: "/api/session" });
    expect(bare.statusCode).toBe(401);
    expect(bare.json<{ code: string }>().code).toBe("demo_token_required");

    // Wrong token also rejected.
    const wrong = await tokened.inject({
      method: "POST",
      url: "/api/session",
      headers: { "x-demo-token": "nope" },
    });
    expect(wrong.statusCode).toBe(401);

    // Right token passes; health stays open.
    const ok = await tokened.inject({
      method: "POST",
      url: "/api/session",
      headers: { "x-demo-token": "sesame-day-token" },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe("face shape on the face route", () => {
  function contourCy(svg: string): number[] {
    const tags = svg.match(/<path\b[^>]*>/g) ?? [];
    const ys: number[] = [];
    for (const tag of tags) {
      if (!/\bdata-zone="contour"/.test(tag)) continue;
      const cy = tag.match(/\bdata-cy="([^"]+)"/);
      if (cy) ys.push(Number(cy[1]));
    }
    return ys.sort((a, b) => a - b);
  }

  async function statementCy(faceShape?: string): Promise<{ cy: number[]; svg: string }> {
    const app = makeApp();
    const { sessionId } = await makeSession(app);
    const face = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/face`,
      payload: {
        faceImageBase64: FACE_B64,
        lock: LOCK,
        landmarks: {
          faceBox: { x: 0.2, y: 0.1, w: 0.6, h: 0.8 },
          ...(faceShape !== undefined ? { faceShape } : {}),
        },
      },
    });
    expect(face.statusCode).toBe(200);
    const looks = await app.inject({
      method: "POST",
      url: `/api/session/${sessionId}/looks`,
      payload: { mood: "Boss", event: "Office" },
    });
    expect(looks.statusCode).toBe(200);
    const body = looks.json<{ looks: { role: string; imageUrl: string }[] }>();
    const statement = body.looks.find((l) => l.role === "statement");
    expect(statement).toBeTruthy();
    const svg = Buffer.from(statement!.imageUrl.split(",")[1]!, "base64").toString("utf8");
    return { cy: contourCy(svg), svg };
  }

  it("remaps long onto oblong contour and drops an unknown label", async () => {
    const oblong = await statementCy("oblong");
    const legacy = await statementCy(" LONG ");
    const dropped = await statementCy("nope");
    const absent = await statementCy(undefined);
    expect(oblong.svg).toContain("#b3122e");
    expect(legacy.cy).toEqual(oblong.cy);
    expect(dropped.cy).toEqual(absent.cy);
    expect(dropped.cy).not.toEqual(oblong.cy);
    expect(oblong.cy[0]).toBeLessThan(250);
    expect(oblong.cy[oblong.cy.length - 1]).toBeGreaterThan(1000);
  });
});
