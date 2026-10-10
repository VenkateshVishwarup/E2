import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRegistry } from "@midfunnel/core/agent/registry";
import { createServer, type Server } from "node:http";
import { ToolBroker, mockBindings } from "../src/broker.js";
import { bindingsFor, describeBindings } from "../src/bindings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const registry = AgentRegistry.fromSpec(spec);
const principal = registry.get("agent://engati/mba-admissions");
const ctx = { leadId: "L1", journey: spec.journey, journeyVersion: spec.version };

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

let pool: Pool; let store: EventStore; let broker: ToolBroker;

beforeAll(async () => { pool = createPool(URL); await migrate(pool); });
beforeEach(async () => {
  await pool.query("TRUNCATE events");
  store = new EventStore(pool, "t1");
  broker = new ToolBroker(registry, store, mockBindings);
});
afterAll(async () => { await pool.end(); });

describe("ToolBroker", () => {
  it("invokes a granted capability and records ToolInvoked", async () => {
    const r = await broker.invoke(ctx, principal, "crm.upsert_lead", { email: "a@b.com" });
    expect(r.ok).toBe(true);

    const events = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(events).toHaveLength(1);
    expect(events[0]!.agentId).toBe(principal.identity);
    expect(events[0]!.payload).toMatchObject({
      capability: "crm.upsert_lead", binding: "mock-crm", resultStatus: "ok",
    });
  });

  it("denies an ungranted capability and records AuthorizationDenied", async () => {
    const r = await broker.invoke(ctx, principal, "payment.charge_card", { amount: 1 });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no privilege/i);

    const denied = await store.query({ leadId: "L1", type: "AuthorizationDenied" });
    expect(denied).toHaveLength(1);
    expect(denied[0]!.payload).toMatchObject({
      capability: "payment.charge_card", principal: principal.identity,
    });
    expect(await store.query({ leadId: "L1", type: "ToolInvoked" })).toEqual([]);
  });

  it("passes the privilege scope through to the binding", async () => {
    const seen: Array<string | undefined> = [];
    const b = new ToolBroker(registry, store, {
      "crm.upsert_lead": async (_a, scope) => { seen.push(scope); return { id: "x" }; },
    });
    await b.invoke(ctx, principal, "crm.upsert_lead", {});
    expect(seen).toEqual(["leads_owned_by_this_journey"]);
  });

  it("records a failing binding as an error without throwing", async () => {
    const b = new ToolBroker(registry, store, {
      "crm.upsert_lead": async () => { throw new Error("hubspot 503"); },
    });
    const r = await b.invoke(ctx, principal, "crm.upsert_lead", {});
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/hubspot 503/);

    const events = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(events[0]!.payload).toMatchObject({ resultStatus: "error" });
  });

  it("never writes raw arguments to the event log", async () => {
    await broker.invoke(ctx, principal, "crm.upsert_lead", { email: "secret@person.com" });
    const [e] = await store.query({ leadId: "L1", type: "ToolInvoked" });
    expect(JSON.stringify(e!.payload)).not.toContain("secret@person.com");
    expect(e!.payload).toHaveProperty("argsHash");
  });
});

describe("ToolBroker — reaching a real system", () => {
  let server: Server;
  let origin: string;
  let received: unknown[] = [];
  let status = 200;

  beforeAll(async () => {
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c as Buffer));
      req.on("end", () => {
        received.push(JSON.parse(Buffer.concat(chunks).toString() || "null"));
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ bookingId: "bk_real_9" }));
      });
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });
  beforeEach(() => { received = []; status = 200; });

  /** The broker as ChatService builds it: resolved per journey, described per journey. */
  const brokerWith = (env: NodeJS.ProcessEnv) => new ToolBroker(
    registry, store, bindingsFor(spec, mockBindings, env),
    Object.fromEntries(describeBindings(spec, mockBindings, env)
      .map((b) => [b.capability, { name: b.binding, live: b.mode === "live" }])),
  );

  const lastTool = async () =>
    (await store.query({ leadId: "L1", type: "ToolInvoked" })).at(-1)!;

  it("calls the configured endpoint and returns what it said", async () => {
    const r = await brokerWith({ BINDING_CALENDLY_URL: `${origin}/book` })
      .invoke(ctx, principal, "calendar.book_slot", { slot: "2026-10-20T10:00:00Z" });
    expect(r).toEqual({ ok: true, value: { bookingId: "bk_real_9" } });
    expect(received).toEqual([{
      capability: "calendar.book_slot", scope: "counsellor_pool_mba",
      args: { slot: "2026-10-20T10:00:00Z" },
    }]);
  });

  it("records the journey's own binding name, and that the call was real", async () => {
    // "booked a slot" and "booked a slot against a mock" are different facts.
    await brokerWith({ BINDING_CALENDLY_URL: `${origin}/book` })
      .invoke(ctx, principal, "calendar.book_slot", {});
    expect((await lastTool()).payload).toMatchObject({
      capability: "calendar.book_slot", binding: "calendly", live: true, resultStatus: "ok",
    });
  });

  it("marks an unconfigured capability as not live, and never leaves the process", async () => {
    await brokerWith({}).invoke(ctx, principal, "calendar.book_slot", {});
    expect(received).toEqual([]);
    expect((await lastTool()).payload).toMatchObject({ binding: "calendly", live: false });
  });

  it("records a failing integration rather than throwing it at the conversation", async () => {
    status = 500;
    const r = await brokerWith({ BINDING_CALENDLY_URL: `${origin}/book` })
      .invoke(ctx, principal, "calendar.book_slot", {});
    expect(r.ok).toBe(false);
    expect((await lastTool()).payload).toMatchObject({
      resultStatus: "error", live: true, binding: "calendly",
    });
  });

  it("still refuses an unprivileged capability before any call is made", async () => {
    const r = await brokerWith({ BINDING_CALENDLY_URL: `${origin}/book` })
      .invoke(ctx, principal, "payment.charge_card", {});
    expect(r.ok).toBe(false);
    expect(received).toEqual([]);
    expect(await store.query({ leadId: "L1", type: "AuthorizationDenied" })).toHaveLength(1);
  });

  it("keeps the arguments out of the log, configured or not", async () => {
    await brokerWith({ BINDING_CALENDLY_URL: `${origin}/book` })
      .invoke(ctx, principal, "calendar.book_slot", { email: "priya@example.com" });
    expect(JSON.stringify((await lastTool()).payload)).not.toContain("priya@example.com");
  });
});
