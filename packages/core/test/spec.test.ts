import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, parseTypeExpr, evidenceToJsonSchema, lintSpec, requiredEvidenceFields,
  renderPinned, pinnedDefaults, pinnedText, isOpen, allowedMoves, knowledgeKeys,
  knowledgeEntry }
  from "../src/journey/spec.js";
import { MOVES } from "../src/journey/moves.js";

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

describe("lintSpec", () => {
  it("flags a journey whose required evidence cannot reach its own threshold", () => {
    // The reference journey needs score >= 70 to qualify, but its required
    // fields top out at 65. The missing 15 sits on `decision_maker`, which is
    // optional - and the runtime stops asking once required fields are done.
    const warnings = lintSpec(parseSpec(yaml));
    const w = warnings.find((x) => x.code === "unreachable_qualification");
    expect(w).toBeDefined();
    expect(w!.message).toContain("at most 65");
    expect(w!.message).toContain("needs 70");
    expect(w!.message).toContain("decision_maker");
  });

  it("is silent once the gap is closed by making the field required", () => {
    const fixed = yaml.replace(
      "  decision_maker:\n    type: enum[self, parent, employer]\n    required: false",
      "  decision_maker:\n    type: enum[self, parent, employer]\n    required: true");
    expect(lintSpec(parseSpec(fixed)).map((w) => w.code))
      .not.toContain("unreachable_qualification");
  });

  it("flags a scoring weight pointing at a field that does not exist", () => {
    const typo = yaml.replace("    timeline.this_intake: 30", "    timelime.this_intake: 30");
    const w = lintSpec(parseSpec(typo)).find((x) => x.code === "unknown_scoring_field");
    expect(w?.message).toContain("timelime");
  });

  it("returns nothing for a journey with no score threshold to miss", () => {
    const loose = yaml.replace(
      "  qualifies_when: score >= 70 AND evidence.complete(required)",
      "  qualifies_when: evidence.complete(required)");
    expect(lintSpec(parseSpec(loose)).map((w) => w.code))
      .not.toContain("unreachable_qualification");
  });
});

describe("pinned template variables", () => {
  it("renders placeholders and reports the ones it could not fill", () => {
    expect(renderPinned("Hi {{name}}, from {{institute}}.", { name: "Priya", institute: "BIM" }))
      .toEqual({ text: "Hi Priya, from BIM.", unresolved: [] });

    const partial = renderPinned("Hi {{name}}, from {{institute}}.", { name: "Priya" });
    expect(partial.unresolved).toEqual(["institute"]);
    // Never leaves braces, and tidies the punctuation the placeholder held up.
    expect(partial.text).not.toMatch(/\{\{|\s{2,}|\s\./);
  });

  it("reads defaults from the spec and knows which variables the runtime supplies", () => {
    const spec = parseSpec(yaml);
    expect(pinnedDefaults(spec)).toEqual({ institute: "the admissions team" });
    expect(pinnedText(spec, "disclosure")).toMatch(/\{\{name\}\}/);
    expect(pinnedText(spec, "variables")).toBeUndefined();
  });

  it("lints a placeholder that has no default and no runtime source", () => {
    const bare = yaml.replace("  variables:\n    institute: the admissions team\n", "");
    const warning = lintSpec(parseSpec(bare))
      .find((w) => w.code === "unresolvable_template_variable");
    expect(warning!.message).toMatch(/\{\{institute\}\}/);
    expect(warning!.message).toMatch(/raw placeholder/);
  });

  it("does not flag a variable the runtime supplies", () => {
    const codes = lintSpec(parseSpec(yaml)).map((w) => w.code);
    expect(codes).not.toContain("unresolvable_template_variable");
  });
});

// ─── Conversation strategy ───────────────────────────────────────────────────

const openYaml = readFileSync(join(HERE, "fixtures/mba-v7-open.yaml"), "utf8");

describe("strategy", () => {
  it("defaults to scripted, so every existing journey behaves as before", () => {
    const s = parseSpec(yaml);
    expect(s.strategy.kind).toBe("scripted");
    expect(isOpen(s)).toBe(false);
  });

  it("defaults to the whole repertoire, not to a subset someone has to remember", () => {
    expect(parseSpec(yaml).strategy.moves.sort()).toEqual([...MOVES].sort());
  });

  it("defaults to refusing an early close", () => {
    // A model that finds a conversation awkward reaches for the exit.
    expect(parseSpec(yaml).strategy.allow_unscripted_close).toBe(false);
  });

  it("reads an open journey's declared repertoire and knowledge", () => {
    const s = parseSpec(openYaml);
    expect(isOpen(s)).toBe(true);
    expect(allowedMoves(s)).toContain("answer");
    expect(knowledgeKeys(s)).toContain("scholarships");
    expect(knowledgeEntry(s, "intakes")).toMatch(/twice a year/);
  });

  it("rejects a move the repertoire does not contain", () => {
    expect(() => parseSpec(openYaml.replace("moves: [ask,", "moves: [improvise,")))
      .toThrow();
  });

  it("rejects an empty repertoire — an agent with no moves is not an agent", () => {
    expect(() => parseSpec(openYaml.replace(
      "  moves: [ask, answer, acknowledge, offer, close, escalate]", "  moves: []",
    ))).toThrow();
  });
});

describe("lintSpec — strategy", () => {
  const codes = (y: string) => lintSpec(parseSpec(y)).map((w) => w.code);

  it("passes the reference open journey", () => {
    // Apart from the unreachable-qualification warning it inherits from v4, which
    // is a property of the shared weights rather than of the strategy.
    expect(codes(openYaml).filter((c) => c !== "unreachable_qualification")).toEqual([]);
  });

  it("warns when an open journey may answer but declares no facts", () => {
    const blind = openYaml.replace(/^knowledge:\n(?:  .*\n|\n)*?(?=^policy:)/m, "knowledge: {}\n");
    expect(parseSpec(blind).knowledge).toEqual({});
    expect(codes(blind)).toContain("unanswerable_open_journey");
  });

  it("warns when the offer move has no tool behind it", () => {
    const toolless = openYaml.replace(/^tools:\n(?:  .*\n)*/m, "tools: []\n");
    expect(codes(toolless)).toContain("unusable_move");
  });

  it("warns when an open journey can only ask, which is what scripted already does", () => {
    const pointless = openYaml.replace(
      "  moves: [ask, answer, acknowledge, offer, close, escalate]", "  moves: [ask]",
    );
    expect(codes(pointless)).toContain("unusable_move");
  });

  it("warns that a scripted journey's knowledge block is inert", () => {
    const mixed = openYaml.replace("  kind: open", "  kind: scripted");
    expect(codes(mixed)).toContain("inert_knowledge");
  });

  it("warns when declared knowledge quotes a figure the policy forbids", () => {
    // Declared knowledge wins — the author should know they wrote both.
    const quoting = openYaml.replace(
      "  fees: >-", "  fees: The fee is ₹12.5 lakh.\n  unused_fees: >-",
    );
    expect(codes(quoting)).toContain("knowledge_contradicts_policy");
  });

  it("does not warn about a figure when the policy permits quoting", () => {
    const quoting = openYaml
      .replace("    - quote_exact_fees\n", "")
      .replace("  fees: >-", "  fees: The fee is ₹12.5 lakh.\n  unused_fees: >-");
    expect(codes(quoting)).not.toContain("knowledge_contradicts_policy");
  });
});
