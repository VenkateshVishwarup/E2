import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "../src/journey/spec.js";
import { AgentRegistry } from "../src/agent/registry.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8"));
const reg = AgentRegistry.fromSpec(spec);
const principal = reg.get("agent://engati/mba-admissions");

describe("AgentRegistry", () => {
  it("resolves the principal declared by the journey", () => {
    expect(principal.persona).toBe("admissions_counsellor_v2");
    expect(principal.privileges).toContain("crm.upsert_lead:leads_owned_by_this_journey");
  });

  it("throws for an unknown identity", () => {
    expect(() => reg.get("agent://engati/nope")).toThrow(/unknown agent/i);
  });

  it("allows a granted capability and returns its scope", () => {
    expect(reg.authorize(principal, "crm.upsert_lead"))
      .toEqual({ allowed: true, scope: "leads_owned_by_this_journey" });
  });

  it("denies a capability that was never granted", () => {
    const r = reg.authorize(principal, "payment.charge_card");
    expect(r.allowed).toBe(false);
    expect(r.reason).toMatch(/no privilege/i);
  });

  it("does not treat a capability prefix as a grant", () => {
    expect(reg.authorize(principal, "crm.upsert_lead_bulk").allowed).toBe(false);
  });

  it("enforces data scope, with deny beating read", () => {
    expect(reg.canRead(principal, "lead.self")).toBe(true);
    expect(reg.canRead(principal, "catalog.programs")).toBe(true);
    expect(reg.canRead(principal, "lead.other_journeys")).toBe(false);
    expect(reg.canRead(principal, "payment.instruments")).toBe(false);
    expect(reg.canRead(principal, "anything.unlisted")).toBe(false);
  });
});
