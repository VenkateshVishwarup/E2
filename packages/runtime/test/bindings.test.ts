import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { mockBindings } from "../src/broker.js";
import { bindingsFor, configFor, describeBindings, envNames, httpBinding } from "../src/bindings.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

/** A stand-in for the vendor, so the live path is exercised rather than mocked. */
let server: Server;
let origin: string;
let received: Array<{ auth: string | undefined; body: unknown }> = [];
let respond: (url: string) => { status: number; body: string; delayMs?: number } =
  () => ({ status: 200, body: JSON.stringify({ id: "crm_1" }) });

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c as Buffer));
    req.on("end", () => {
      received.push({
        auth: req.headers.authorization,
        body: JSON.parse(Buffer.concat(chunks).toString() || "null"),
      });
      const r = respond(req.url ?? "");
      const send = () => { res.writeHead(r.status, { "content-type": "application/json" }); res.end(r.body); };
      if (r.delayMs) setTimeout(send, r.delayMs); else send();
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const addr = server.address() as { port: number };
  origin = `http://127.0.0.1:${addr.port}`;
});
afterAll(async () => { await new Promise<void>((r) => server.close(() => r())); });

const reset = () => {
  received = [];
  respond = () => ({ status: 200, body: JSON.stringify({ id: "crm_1" }) });
};

describe("envNames", () => {
  it("derives one set of names from the binding the journey declared", () => {
    expect(envNames("hubspot")).toEqual({
      url: "BINDING_HUBSPOT_URL", token: "BINDING_HUBSPOT_TOKEN", timeout: "BINDING_HUBSPOT_TIMEOUT",
    });
  });
  it("normalises a name that is not already an identifier", () => {
    expect(envNames("acme-crm.v2").url).toBe("BINDING_ACME_CRM_V2_URL");
  });
});

describe("configFor", () => {
  it("is null when nothing is configured, which is what makes it a mock", () => {
    expect(configFor("hubspot", {})).toBeNull();
  });
  it("reads the url, the token and a timeout", () => {
    expect(configFor("hubspot", {
      BINDING_HUBSPOT_URL: "https://crm.example/hook",
      BINDING_HUBSPOT_TOKEN: "s3cret",
      BINDING_HUBSPOT_TIMEOUT: "250",
    })).toEqual({ url: "https://crm.example/hook", token: "s3cret", timeoutMs: 250 });
  });
  it("ignores a nonsense timeout rather than disabling the deadline", () => {
    expect(configFor("hubspot", {
      BINDING_HUBSPOT_URL: "https://crm.example/hook", BINDING_HUBSPOT_TIMEOUT: "soon",
    })!.timeoutMs).toBe(8000);
  });
  it("treats a blank url as unconfigured", () => {
    expect(configFor("hubspot", { BINDING_HUBSPOT_URL: "   " })).toBeNull();
  });
});

describe("httpBinding", () => {
  it("posts the capability, scope and arguments, and returns the response", async () => {
    reset();
    const call = httpBinding("crm.upsert_lead", { url: `${origin}/hook`, token: "s3cret", timeoutMs: 2000 });
    expect(await call({ leadId: "L1" }, "leads_owned_by_this_journey")).toEqual({ id: "crm_1" });
    expect(received[0]).toEqual({
      auth: "Bearer s3cret",
      body: { capability: "crm.upsert_lead", scope: "leads_owned_by_this_journey", args: { leadId: "L1" } },
    });
  });

  it("sends no authorization header when no token is configured", async () => {
    reset();
    await httpBinding("crm.upsert_lead", { url: `${origin}/hook`, timeoutMs: 2000 })({});
    expect(received[0]!.auth).toBeUndefined();
  });

  it("fails on an error status, with the vendor's own message", async () => {
    reset();
    respond = () => ({ status: 422, body: "lead is missing an email" });
    const call = httpBinding("crm.upsert_lead", { url: `${origin}/hook`, timeoutMs: 2000 });
    await expect(call({})).rejects.toThrow(/returned 422: lead is missing an email/);
  });

  it("gives up on a slow integration rather than holding the conversation", async () => {
    reset();
    respond = () => ({ status: 200, body: "{}", delayMs: 300 });
    const call = httpBinding("crm.upsert_lead", { url: `${origin}/hook`, timeoutMs: 60 });
    await expect(call({})).rejects.toThrow();
  });

  it("does not retry — a double booking is worse than a failed one", async () => {
    reset();
    respond = () => ({ status: 503, body: "upstream busy" });
    await expect(httpBinding("calendar.book_slot", { url: `${origin}/hook`, timeoutMs: 2000 })({}))
      .rejects.toThrow(/503/);
    expect(received).toHaveLength(1);
  });

  it("handles an empty success body", async () => {
    reset();
    respond = () => ({ status: 204, body: "" });
    expect(await httpBinding("crm.upsert_lead", { url: `${origin}/hook`, timeoutMs: 2000 })({})).toBeNull();
  });
});

describe("bindingsFor", () => {
  it("falls back to the mock for every unconfigured binding", async () => {
    const resolved = bindingsFor(spec, mockBindings, {});
    expect(Object.keys(resolved).sort())
      .toEqual(["calendar.book_slot", "catalog.lookup_program", "crm.upsert_lead"]);
    expect(await resolved["crm.upsert_lead"]!({ a: 1 })).toMatchObject({ binding: "mock-crm" });
  });

  it("resolves a configured binding to the real endpoint", async () => {
    reset();
    const resolved = bindingsFor(spec, mockBindings, { BINDING_HUBSPOT_URL: `${origin}/crm` });
    expect(await resolved["crm.upsert_lead"]!({ leadId: "L1" })).toEqual({ id: "crm_1" });
    expect(received).toHaveLength(1);
  });

  it("resolves through the name the journey declared, not the capability", async () => {
    // Two journeys naming different CRMs reached the same place before, and the
    // spec's answer to "which system" was decoration.
    reset();
    const resolved = bindingsFor(spec, mockBindings, { BINDING_CALENDLY_URL: `${origin}/cal` });
    await resolved["calendar.book_slot"]!({});
    expect(received).toHaveLength(1);
    // The CRM is still a mock: only calendly was configured.
    await resolved["crm.upsert_lead"]!({});
    expect(received).toHaveLength(1);
  });
});

describe("describeBindings", () => {
  it("reports every tool as a mock when nothing is configured, and says why", () => {
    expect(describeBindings(spec, mockBindings, {})).toEqual([
      { capability: "crm.upsert_lead", binding: "hubspot", mode: "mock", endpoint: null,
        reason: "BINDING_HUBSPOT_URL is not set" },
      { capability: "calendar.book_slot", binding: "calendly", mode: "mock", endpoint: null,
        reason: "BINDING_CALENDLY_URL is not set" },
      { capability: "catalog.lookup_program", binding: "internal", mode: "mock", endpoint: null,
        reason: "BINDING_INTERNAL_URL is not set" },
    ]);
  });

  it("reports a configured binding as live, by host only", () => {
    // A full URL in an API response is a path and a query string in a screenshot.
    const [crm] = describeBindings(spec, mockBindings, {
      BINDING_HUBSPOT_URL: "https://crm.example.com/e2/hooks?team=7",
    });
    expect(crm).toEqual({
      capability: "crm.upsert_lead", binding: "hubspot", mode: "live",
      endpoint: "crm.example.com", reason: null,
    });
  });

  it("never reports a token", () => {
    const described = describeBindings(spec, mockBindings, {
      BINDING_HUBSPOT_URL: "https://crm.example.com/hooks", BINDING_HUBSPOT_TOKEN: "s3cret",
    });
    expect(JSON.stringify(described)).not.toContain("s3cret");
  });

  it("says when a capability has neither configuration nor a mock", () => {
    const [only] = describeBindings(spec, {}, {});
    expect(only!.reason).toMatch(/no mock for crm.upsert_lead/);
  });
});
