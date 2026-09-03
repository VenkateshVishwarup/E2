import { describe, it, expect, beforeAll, beforeEach, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRegistry } from "@midfunnel/core/agent/registry";
import { ToolBroker, mockBindings } from "../src/broker.js";

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
