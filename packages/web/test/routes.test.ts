import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { buildServer } from "../src/server.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const V3 = V4.replace("version: 4", "version: 3");

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const LIFT = {
  n: 30,
  a: { version: 3, qualifiedRate: 0.18, projectedConversions: 3.4 },
  b: { version: 4, qualifiedRate: 0.24, projectedConversions: 4.1 },
  absoluteLift: 0.06,
  ci95: [0.02, 0.1] as [number, number],
  observedConversionByDecision: { hot: 0.31, cold: 0.02 },
  divergent: [],
};

const ROI = {
  journey: "mba-admissions-qualification", currency: "INR",
  metricKinds: { booleans: ["conversion"], aggregates: ["revenue"] },
  total: {
    leads: 30, counts: { conversion: 6 }, sums: { revenue: 900 },
    mediaCost: 3000, modelCost: 120, totalCost: 3120,
    costPer: { conversion: 520 }, returnOnSpend: { revenue: 0.29 },
  },
  tree: [], caveats: ["Media spend is allocated evenly."],
};

const ANSWER = {
  text: "needs_financing converts 31% worse.", usedTools: ["insights"], offline: true,
};

const STUB = {
  registry: { list: vi.fn(), get: vi.fn(), diff: vi.fn(), latest: vi.fn() } as never,
  simulate: { run: vi.fn(), compare: vi.fn() } as never,
  attribution: { roll: vi.fn() } as never,
  insights: { insights: vi.fn() } as never,
  copilot: { ask: vi.fn() },
  chat: { start: vi.fn(), send: vi.fn(), state: vi.fn(), findByAddress: vi.fn() },
  offline: true,
};

let pool: Pool;
let app: ReturnType<typeof buildServer>;
let copilotAsk: ReturnType<typeof vi.fn>;
/** The chat the server is actually built with, so a test can drive it. */
let chat: {
  start: ReturnType<typeof vi.fn>; send: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>; findByAddress: ReturnType<typeof vi.fn>;
};

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE journey_versions CASCADE");
  const registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V3);
  await registry.publish(V4);
  copilotAsk = vi.fn().mockResolvedValue(ANSWER);
  chat = { start: vi.fn(), send: vi.fn(), state: vi.fn(), findByAddress: vi.fn() };
  app = buildServer({
    registry,
    store: new EventStore(pool, "t1"),
    replay: { replay: vi.fn().mockResolvedValue(LIFT) } as never,
    simulate: { run: vi.fn(), compare: vi.fn() } as never,
    attribution: { roll: vi.fn().mockResolvedValue(ROI) } as never,
    insights: { insights: vi.fn().mockResolvedValue({ journey: "j", leadsAnalysed: 30, findings: [], skipped: [] }) } as never,
    copilot: { ask: copilotAsk },
    chat,
  offline: true,
  });
});
afterAll(async () => { await pool.end(); });

describe("web routes", () => {
  it("reports health", async () => {
    const res = await app.inject({ method: "GET", url: "/health" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ ok: true });
  });

  it("lists every journey, so the console is not pinned to one", async () => {
    const res = await app.inject({ url: "/api/journeys" });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      journeys: [{ journey: "mba-admissions-qualification", versions: 2, latest: 4, live: 3 }],
    });
  });

  it("lists a journey as soon as its first version is published, and makes it live", async () => {
    const yaml = V4.replace(/^journey: .*$/m, "journey: pgdm-admissions").replace("version: 4", "version: 1");
    const published = await app.inject({ method: "POST", url: "/api/journeys/publish", payload: { yaml } });
    expect(published.statusCode).toBe(200);

    const names = (await app.inject({ url: "/api/journeys" })).json().journeys;
    expect(names).toContainEqual({ journey: "pgdm-admissions", versions: 1, latest: 1, live: 1 });
  });

  it("refuses to publish a journey whose name a URL cannot carry", async () => {
    const yaml = V4.replace(/^journey: .*$/m, "journey: PGDM Admissions");
    const res = await app.inject({ method: "POST", url: "/api/journeys/publish", payload: { yaml } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/journey name/);
  });

  it("lists journey versions newest first", async () => {
    const res = await app.inject({ url: "/api/journeys/mba-admissions-qualification/versions" });
    expect(res.json()).toMatchObject({ versions: [4, 3] });
  });

  it("says which strategy each version runs, so a picker can label them", async () => {
    const res = await app.inject({ url: "/api/journeys/mba-admissions-qualification/versions" });
    expect(res.json().strategies).toEqual({ 3: "scripted", 4: "scripted" });
  });

  it("returns a structural diff between two versions", async () => {
    const res = await app.inject({
      url: "/api/journeys/mba-admissions-qualification/diff?a=3&b=4",
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().changes.some((c: { path: string }) => c.path === "version")).toBe(true);
  });

  it("runs a replay and returns the lift", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/replay",
      payload: { journey: "mba-admissions-qualification", a: 3, b: 4, leadIds: ["L_1"] },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ absoluteLift: 0.06, ci95: [0.02, 0.1] });
  });

  it("rejects a replay with a malformed body", async () => {
    const res = await app.inject({ method: "POST", url: "/api/replay", payload: { journey: 1 } });
    expect(res.statusCode).toBe(400);
  });

  it("404s an unknown journey rather than throwing", async () => {
    const res = await app.inject({ url: "/api/journeys/nope/diff?a=1&b=2" });
    expect(res.statusCode).toBe(404);
  });
});

describe("intelligence routes", () => {
  const journey = "mba-admissions-qualification";

  it("serves the attribution fold", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/roi` });
    expect(res.statusCode).toBe(200);
    expect(res.json().total.costPer.conversion).toBe(520);
  });

  it("rejects a currency that is not an ISO code", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/roi?currency=rupees` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/three-letter ISO/);
  });

  it("passes a tenant's own metric names through to the insight engine", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/insights?conversion=booked` });
    expect(res.statusCode).toBe(200);
    expect(res.json().leadsAnalysed).toBe(30);
  });

  it("answers a copilot question", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/copilot/ask",
      payload: { journey, question: "Why is my needs_financing cohort converting worse?" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().offline).toBe(true);
    expect(copilotAsk).toHaveBeenCalledWith(journey, "Why is my needs_financing cohort converting worse?");
  });

  it("rejects an empty question and an essay, without calling the model", async () => {
    for (const question of ["   ", "x".repeat(501)]) {
      const res = await app.inject({
        method: "POST", url: "/api/copilot/ask", payload: { journey, question },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(copilotAsk).not.toHaveBeenCalled();
  });

  it("reports the static checks against a version before anything is run", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/lint?version=4` });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(4);
    // v4 is the version whose required evidence tops out below its own threshold.
    expect(res.json().warnings.map((w: { code: string }) => w.code))
      .toContain("unreachable_qualification");
  });

  it("lints the latest version when none is named", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/lint` });
    expect(res.json().version).toBe(4);
  });

  it("rejects a version that is not a positive integer", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/lint?version=four` });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/positive integer/);
  });

  it("distinguishes a missing journey from an upstream failure", async () => {
    const failing = buildServer({
      registry: { list: vi.fn(), get: vi.fn(), diff: vi.fn(), latest: vi.fn() } as never,
      store: new EventStore(pool, "t1"),
      replay: {} as never, simulate: {} as never,
      attribution: { roll: vi.fn().mockRejectedValue(new Error("journey not found: nope")) } as never,
      insights: { insights: vi.fn().mockRejectedValue(new Error("connection refused")) } as never,
      copilot: { ask: vi.fn() },
  chat: { start: vi.fn(), send: vi.fn(), state: vi.fn(), findByAddress: vi.fn() },
  offline: true,
    });
    expect((await failing.inject({ url: "/api/journeys/nope/roi" })).statusCode).toBe(404);
    expect((await failing.inject({ url: "/api/journeys/j/insights" })).statusCode).toBe(502);
  });
});

describe("authoring", () => {
  const journey = "mba-admissions-qualification";

  it("returns the authored YAML byte for byte, since key order is load-bearing", async () => {
    const res = await app.inject({ url: `/api/journeys/${journey}/source?version=4` });
    expect(res.statusCode).toBe(200);
    expect(res.json().yaml).toBe(V4);
  });

  it("treats a malformed draft as a lint result, not a failed request", async () => {
    // An editor's caller needs the message to display, not a 500.
    const res = await app.inject({
      method: "POST", url: "/api/journeys/lint", payload: { yaml: "journey: x\nversion: nope" },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().valid).toBe(false);
    expect(res.json().error).toBeTruthy();
  });

  it("lints a valid draft that has not been published", async () => {
    const draft = V4.replace("version: 4", "version: 9");
    const res = await app.inject({ method: "POST", url: "/api/journeys/lint", payload: { yaml: draft } });
    expect(res.json()).toMatchObject({ valid: true, version: 9 });
    expect(res.json().warnings.map((w: { code: string }) => w.code))
      .toContain("unreachable_qualification");
  });

  it("publishes a new version and reports its warnings without blocking it", async () => {
    const draft = V4.replace("version: 4", "version: 8");
    const res = await app.inject({ method: "POST", url: "/api/journeys/publish", payload: { yaml: draft } });
    expect(res.statusCode).toBe(200);
    expect(res.json().version).toBe(8);
    // Published, and immediately servable.
    const versions = await app.inject({ url: `/api/journeys/${journey}/versions` });
    expect(versions.json().versions).toContain(8);
  });

  it("refuses to republish a version, with 409 rather than a server error", async () => {
    const res = await app.inject({ method: "POST", url: "/api/journeys/publish", payload: { yaml: V4 } });
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/already published/);
  });

  it("rejects a draft that is empty or absurdly large before parsing it", async () => {
    for (const yaml of ["   ", "x".repeat(40_001)]) {
      const res = await app.inject({ method: "POST", url: "/api/journeys/publish", payload: { yaml } });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe("cohort sampling", () => {
  it("spreads a capped replay across the cohort instead of taking the oldest slice", async () => {
    // Leads arrive in event order, so a prefix is the oldest part of the
    // campaign — a different creative mix and a different time of day.
    const seen: string[][] = [];
    const capturing = buildServer({
      ...STUB, store: new EventStore(pool, "t1"),
      replay: { replay: vi.fn(async (_j, _a, _b, ids: string[]) => { seen.push(ids); return LIFT; }) } as never,
    });
    const store = new EventStore(pool, "t1");
    await store.appendMany(Array.from({ length: 100 }, (_, i) => ({
      leadId: `L${String(i).padStart(3, "0")}`, journey: "mba-admissions-qualification",
      journeyVersion: 4, agentId: "a", type: "LeadIngested" as const, payload: {},
      occurredAt: new Date(Date.UTC(2026, 5, 1, 0, i)),
    })));

    await capturing.inject({
      method: "POST", url: "/api/replay",
      payload: { journey: "mba-admissions-qualification", a: 3, b: 4, n: 10 },
    });

    const ids = seen[0]!;
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe("L000");
    // Reaches the far end of the cohort, which a prefix never would.
    expect(ids.at(-1)).toBe("L090");
    // Deterministic: the same cap always yields the same leads.
    await capturing.inject({
      method: "POST", url: "/api/replay",
      payload: { journey: "mba-admissions-qualification", a: 3, b: 4, n: 10 },
    });
    expect(seen[1]).toEqual(ids);
  });
});

describe("channels", () => {
  it("reports what each channel can do in this deployment", async () => {
    const res = await app.inject({ url: "/api/channels" });
    expect(res.statusCode).toBe(200);
    const channels = res.json().channels as Array<Record<string, unknown>>;
    expect(channels.map((c) => c.channel)).toEqual(["web", "whatsapp", "voice"]);
    expect(channels.find((c) => c.channel === "voice")).toMatchObject({
      spoken: true, configured: false,
    });
    // Unconfigured, it names the variable that would make it real.
    expect(String(channels.find((c) => c.channel === "whatsapp")!.reason))
      .toContain("CHANNEL_WHATSAPP_URL");
  });

  it("refuses an inbound message on a channel that is not one", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/channels/telepathy/inbound",
      payload: { from: "+911234567890", text: "hi" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("refuses an inbound message on web, which has no address", async () => {
    const res = await app.inject({
      method: "POST", url: "/api/channels/web/inbound",
      payload: { from: "+911234567890", text: "hi" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("requires a sender and a message", async () => {
    for (const payload of [{ text: "hi" }, { from: "+91123" }, { from: "+91123", text: "  " }]) {
      const res = await app.inject({
        method: "POST", url: "/api/channels/whatsapp/inbound", payload,
      });
      expect(res.statusCode).toBe(400);
    }
  });

  it("needs a journey to open a conversation with an address it has not seen", async () => {
    chat.findByAddress.mockResolvedValue(null);
    const res = await app.inject({
      method: "POST", url: "/api/channels/whatsapp/inbound",
      payload: { from: "+911234567890", text: "hi" },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/journey .* is required/);
  });

  it("opens a conversation for a new address and delivers what they said into it", async () => {
    // Nothing the lead said is dropped on the way in: the disclosure goes out,
    // and their own first message is then the first thing the agent answers.
    chat.findByAddress.mockResolvedValue(null);
    chat.start.mockResolvedValue({ reply: "Hi", state: { leadId: "web_new" } });
    chat.send.mockResolvedValue({ reply: "Which programme?", state: { leadId: "web_new" } });

    const res = await app.inject({
      method: "POST", url: "/api/channels/whatsapp/inbound",
      payload: { from: "+911234567890", text: "tell me about the MBA", journey: "mba-admissions-qualification" },
    });
    expect(res.statusCode).toBe(200);
    expect(chat.start).toHaveBeenCalledWith(expect.objectContaining({
      journey: "mba-admissions-qualification", channel: "whatsapp", address: "+911234567890",
      consentChannels: ["whatsapp"],
    }));
    expect(chat.send).toHaveBeenCalledWith("web_new", "tell me about the MBA");
    expect(res.json().reply).toBe("Which programme?");
  });

  it("continues the conversation an address is already having", async () => {
    chat.findByAddress.mockResolvedValue("web_existing");
    chat.send.mockResolvedValue({ reply: "Noted.", state: { leadId: "web_existing" } });
    const res = await app.inject({
      method: "POST", url: "/api/channels/whatsapp/inbound",
      payload: { from: "+911234567890", text: "next intake" },
    });
    expect(res.statusCode).toBe(200);
    expect(chat.start).not.toHaveBeenCalled();
    expect(chat.send).toHaveBeenCalledWith("web_existing", "next intake");
  });
});
