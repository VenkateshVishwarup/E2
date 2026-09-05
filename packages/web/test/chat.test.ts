import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { offlineClient } from "@midfunnel/runtime/offline-client";
import { ChatService } from "../src/chat-service.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const V5 = V4.replace("version: 4", "version: 5");
const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const JOURNEY = "mba-admissions-qualification";
const FX = { currency: "INR", perUsd: 8300 };

let pool: Pool;
let store: EventStore;
let registry: JourneyRegistry;
let chat: ChatService;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  await pool.query("TRUNCATE journey_versions CASCADE");
  store = new EventStore(pool, "t1");
  registry = new JourneyRegistry(pool, "t1");
  await registry.publish(V4);
  await registry.publish(V5);
  // No credential in tests: the deterministic extractor and offline client, the
  // same pair the server falls back to.
  const runtime = new AgentRuntime(new KeywordExtractor() as never, offlineClient());
  chat = new ChatService(store, registry, runtime, FX, true);
});
afterAll(async () => { await pool.end(); });

describe("starting a session", () => {
  it("opens with the pinned disclosure, never a model call", async () => {
    const { reply, state } = await chat.start({ journey: JOURNEY, version: 4 });
    expect(reply).toBe("Hi there, I'm an AI assistant from the admissions team.");
    expect(state.turns).toHaveLength(1);
    expect(state.turns[0]!.role).toBe("agent");
  });

  it("renders pinned placeholders rather than sending them to a person", async () => {
    // The failure this guards: a lead receiving "Hi {{name}}" verbatim.
    const { reply } = await chat.start({
      journey: JOURNEY, version: 4,
      variables: { name: "Priya", institute: "Bengaluru Institute of Management" },
    });
    expect(reply).toBe("Hi Priya, I'm an AI assistant from Bengaluru Institute of Management.");
    expect(reply).not.toMatch(/\{\{/);
  });

  it("falls back to the spec's declared defaults, and never leaves braces behind", async () => {
    const bare = V4.replace("version: 4", "version: 7")
      .replace('  variables:\n    institute: the admissions team\n', "");
    await registry.publish(bare);
    const { reply } = await chat.start({ journey: JOURNEY, version: 7 });
    expect(reply).not.toMatch(/\{\{/);

    const sent = await store.query({ type: "MessageSent" });
    expect(sent.at(-1)!.payload.unresolvedVariables).toEqual(["institute"]);
  });

  it("serves the LIVE version when none is named, not the newest", async () => {
    // v4 was published first and so is live; v5 exists but has not been
    // promoted. A version published in order to try it is not a version anyone
    // has chosen to ship.
    expect(await registry.liveVersion(JOURNEY)).toBe(4);
    expect((await chat.start({ journey: JOURNEY })).state.version).toBe(4);
  });

  it("serves a published-but-not-live version on request, which is how you test one", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 5 });
    expect(state.version).toBe(5);
    // Trying it did not ship it.
    expect(await registry.liveVersion(JOURNEY)).toBe(4);
  });

  it("follows the live pointer once a version is promoted", async () => {
    await registry.promote(JOURNEY, 5);
    expect((await chat.start({ journey: JOURNEY })).state.version).toBe(5);
    // And back again: promoting is reversible, which is what makes it safe.
    await registry.promote(JOURNEY, 4);
    expect((await chat.start({ journey: JOURNEY })).state.version).toBe(4);
  });

  it("writes live-scoped events that the ordinary read path can see", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    const events = await store.query({ leadId: state.leadId });
    expect(events.length).toBeGreaterThan(0);
    // Live traffic carries no runId; the store refuses one on a live event.
    expect(events.every((e) => e.env === "live" && e.runId === null)).toBe(true);
    expect(events[0]!.type).toBe("LeadIngested");
    expect(events[0]!.agentId).toBe("agent://engati/mba-admissions");
  });

  it("prefixes the lead so a seed script's cleanup cannot delete it", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    expect(state.leadId).toMatch(/^web_[0-9a-f]{16}$/);
    // The seeds delete `L\_%`; a real conversation must survive that.
    await pool.query("DELETE FROM events WHERE lead_id LIKE 'L\\_%'");
    expect((await store.query({ leadId: state.leadId })).length).toBeGreaterThan(0);
  });

  it("refuses a journey that does not exist", async () => {
    await expect(chat.start({ journey: "no-such-journey" }))
      .rejects.toThrow(/not found/i);
  });
});

describe("holding a conversation", () => {
  it("collects evidence turn by turn and reports what is still missing", async () => {
    const { state: opened } = await chat.start({ journey: JOURNEY, version: 4 });
    expect(opened.missingRequired).toEqual(["target_program", "timeline", "budget_band"]);

    const first = await chat.send(opened.leadId, "I want the executive_mba");
    expect(first.state.evidence.find((e) => e.field === "target_program")!.value)
      .toBe("executive_mba");
    expect(first.state.missingRequired).not.toContain("target_program");

    const second = await chat.send(opened.leadId, "this_intake, and my budget is above_15L");
    expect(second.state.missingRequired).toEqual([]);
    // Required evidence complete: the runtime scores and routes on that turn.
    expect(second.state.score).toBeGreaterThan(0);
    expect(second.state.decision).not.toBeNull();
    expect(second.state.completed).toBe(true);
  });

  it("evaluates the journey's own metrics rather than a platform definition", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    await chat.send(state.leadId, "executive_mba");
    const done = await chat.send(state.leadId, "this_intake above_15L self");
    expect(Object.keys(done.state.metrics).sort())
      .toEqual(["booked", "conversion", "qualified_lead", "revenue"]);
    expect(typeof done.state.metrics.qualified_lead).toBe("boolean");
    expect(typeof done.state.metrics.revenue).toBe("number");
  });

  it("marks a sensitive field so the opener cannot lead with it", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    expect(state.evidence.find((e) => e.field === "budget_band")!.sensitive).toBe(true);
  });

  it("fires a declared escalation and then has nothing more to say", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    const escalated = await chat.send(state.leadId, "can I talk to a human please");
    expect(escalated.state.escalated).toBe(true);
    expect(escalated.state.escalationRule).toBe("asks_for_human");
    expect(escalated.reply).toBeNull();
  });

  it("survives a restart, because state is folded from the log not held in memory", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    await chat.send(state.leadId, "executive_mba");

    const restarted = new ChatService(
      new EventStore(pool, "t1"), new JourneyRegistry(pool, "t1"),
      new AgentRuntime(new KeywordExtractor() as never, offlineClient()), FX, true,
    );
    const after = await restarted.state(state.leadId);
    expect(after.turns.length).toBeGreaterThan(1);
    expect(after.evidence.find((e) => e.field === "target_program")!.value).toBe("executive_mba");
  });

  it("rejects a lead id that is not a chat session", async () => {
    await expect(chat.send("L_seeded_42", "hello")).rejects.toThrow(/not a chat session/);
    await expect(chat.send("web_deadbeefdeadbeef", "hello")).rejects.toThrow(/not found/);
  });
});

describe("live A/B", () => {
  it("splits real traffic across versions deterministically", async () => {
    const versions = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const { state } = await chat.start({ journey: JOURNEY, split: { "4": 50, "5": 50 } });
      versions.add(state.version);
    }
    // Both arms served, and each session is pinned to the version it started on.
    expect([...versions].sort()).toEqual([4, 5]);
  });

  it("keeps a session on the version it started with", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    const next = await chat.send(state.leadId, "executive_mba");
    expect(next.state.version).toBe(4);
    const events = await store.query({ leadId: state.leadId });
    expect(new Set(events.map((e) => e.journeyVersion))).toEqual(new Set([4]));
  });
});

describe("cost", () => {
  it("reports zero as a fact when no model call was made, not as an estimate", async () => {
    const { state } = await chat.start({ journey: JOURNEY, version: 4 });
    expect(state.modelCost).toBe(0);
    expect(state.offline).toBe(true);
    // No CostObserved is written at all, rather than a zero-valued one.
    const costs = await store.query({ leadId: state.leadId, type: "CostObserved" });
    expect(costs).toHaveLength(0);
  });
});
