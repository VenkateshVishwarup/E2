import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, parseTypeExpr, evidenceToJsonSchema, requiredEvidenceFields }
  from "../src/journey/spec.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(join(HERE, "fixtures/mba-v4.yaml"), "utf8");

describe("parseTypeExpr", () => {
  it("parses an enum expression", () => {
    expect(parseTypeExpr("enum[executive_mba, full_time_mba, online_mba]"))
      .toEqual({ kind: "enum", values: ["executive_mba", "full_time_mba", "online_mba"] });
  });
  it("parses scalars", () => {
    expect(parseTypeExpr("string")).toEqual({ kind: "string" });
    expect(parseTypeExpr("number")).toEqual({ kind: "number" });
  });
  it("rejects nonsense", () => {
    expect(() => parseTypeExpr("enum[")).toThrow(/type expression/i);
  });
});

describe("parseSpec", () => {
  it("parses the reference MBA journey", () => {
    const s = parseSpec(yaml);
    expect(s.journey).toBe("mba-admissions-qualification");
    expect(s.version).toBe(4);
    expect(s.agent.identity).toBe("agent://engati/mba-admissions");
    expect(s.agent.privileges).toHaveLength(3);
    expect(s.objective.goal).toBe("book_counselling_call");
    expect(Object.keys(s.evidence)).toContain("budget_band");
    expect(s.evidence.budget_band?.sensitive).toBe(true);
    expect(s.policy.never).toContain("promise_admission");
    expect(s.metrics.conversion).toMatch(/OutcomeObserved/);
    expect(s.tools.map((t) => t.capability)).toContain("crm.upsert_lead");
  });

  it("rejects a spec with no agent identity", () => {
    const bad = yaml.replace("identity: agent://engati/mba-admissions", "identity: ''");
    expect(() => parseSpec(bad)).toThrow(/identity/);
  });

  it("rejects a spec declaring a tool it has no privilege for", () => {
    const bad = yaml.replace("  - capability: crm.upsert_lead",
                             "  - capability: payment.charge_card");
    expect(() => parseSpec(bad)).toThrow(/payment\.charge_card.*privilege/i);
  });

  it("rejects an `otherwise` rule that is not declared last", () => {
    // An `otherwise` ahead of another rule shadows it entirely.
    const bad = yaml.replace(
      /routing:\n(.*\n)*?\ntools:/,
      [
        "routing:",
        "  cold: { when: \"otherwise\",   target: \"nurture.mba_longtail_90d\" }",
        "  hot:  { when: \"score >= 70\", target: \"handoff.counsellor\", sla: 5m }",
        "",
        "tools:",
      ].join("\n"),
    );
    expect(() => parseSpec(bad)).toThrow(/not declared last|shadow/i);
  });

  it("rejects a spec with no catch-all routing rule", () => {
    const bad = yaml.replace('  cold: { when: "otherwise",   target: "nurture.mba_longtail_90d" }\n', "");
    expect(() => parseSpec(bad)).toThrow(/exactly one "otherwise"/i);
  });

  it("lists required evidence fields only", () => {
    expect(requiredEvidenceFields(parseSpec(yaml)).sort())
      .toEqual(["budget_band", "target_program", "timeline"]);
  });
});

describe("evidenceToJsonSchema", () => {
  it("compiles the evidence block into a strict JSON Schema", () => {
    const js = evidenceToJsonSchema(parseSpec(yaml)) as never as {
      type: string;
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, { type?: string; enum?: string[]; maxLength?: number }>;
    };
    expect(js.type).toBe("object");
    expect(js.additionalProperties).toBe(false);
    expect(js.required.sort()).toEqual([
      "budget_band", "decision_maker", "prior_qualification", "target_program", "timeline",
    ]);
    expect((js.properties.target_program as never as { properties: { value: { enum: string[] } } })
      .properties.value.enum).toEqual(["executive_mba", "full_time_mba", "online_mba", null]);
    expect((js.properties.prior_qualification as never as { properties: { value: { maxLength: number } } })
      .properties.value.maxLength).toBe(120);
  });
});
