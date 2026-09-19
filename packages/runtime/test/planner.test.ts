import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { ModelPlanner, OfflinePlanner } from "../src/planner.js";
import type { Evidence } from "../src/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../core/test/fixtures");
const open = parseSpec(readFileSync(join(FIXTURES, "mba-v7-open.yaml"), "utf8"));

const state = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "L1", journey: open.journey, journeyVersion: open.version,
  evidence: {}, turns: [], outcomes: [], moves: [], ...over,
});
const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });
const ev = (o: Record<string, string>): Evidence =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

describe("OfflinePlanner", () => {
  const planner = new OfflinePlanner();

  it("answers when the question matches a declared knowledge topic", async () => {
    const p = await planner.plan(open,
      state({ turns: [turn("agent", "hi"), turn("lead", "what are the scholarships like?")] }), {});
    expect(p).toMatchObject({ move: "answer", knowledgeKey: "scholarships" });
  });

  it("proposes an answer with no key when nothing covers the question", async () => {
    // On purpose: the guardrail turns this into an honest deflection, and that is
    // the path a real planner reaches most often.
    const p = await planner.plan(open,
      state({ turns: [turn("agent", "hi"), turn("lead", "is there parking on campus?")] }), {});
    expect(p).toMatchObject({ move: "answer", knowledgeKey: null });
  });

  it("does not match a topic on one incidental shared word", async () => {
    const p = await planner.plan(open,
      state({ turns: [turn("lead", "does the team play cricket?")] }), {});
    expect(p.knowledgeKey).toBeNull();
  });

  it("asks for the next missing field when the lead is not asking anything", async () => {
    const p = await planner.plan(open,
      state({ turns: [turn("agent", "hi"), turn("lead", "the executive one")] }),
      ev({ target_program: "executive_mba" }));
    expect(p).toMatchObject({ move: "ask", targetField: "timeline" });
    expect(p.message).not.toBe("");
  });

  it("closes once required evidence is complete", async () => {
    const p = await planner.plan(open, state({ turns: [turn("lead", "5L to 15L")] }),
      ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "5L_to_15L" }));
    expect(p.move).toBe("close");
  });

  it("gives a rationale for every decision", async () => {
    for (const text of ["what are the fees?", "the online one", "5L to 15L"]) {
      const p = await planner.plan(open, state({ turns: [turn("lead", text)] }), {});
      expect(p.rationale.length).toBeGreaterThan(0);
    }
  });
});

describe("ModelPlanner", () => {
  const reply = (parsed: unknown) =>
    ({ responses: { parse: vi.fn().mockResolvedValue({ output_parsed: parsed, usage: {} }) } });

  const good = {
    move: "answer", rationale: "they asked about intakes", message: "Of course.",
    target_field: null, knowledge_key: "intakes", capability: null, confidence: 0.9,
  };

  it("maps the structured reply onto a proposal", async () => {
    const client = reply(good);
    const p = await new ModelPlanner(client as never).plan(open, state(), {});
    expect(p).toEqual({
      move: "answer", rationale: "they asked about intakes", message: "Of course.",
      targetField: null, knowledgeKey: "intakes", capability: null, confidence: 0.9,
    });
  });

  it("constrains the schema to the moves this journey allows", async () => {
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open, state(), {});
    const schema = client.responses.parse.mock.calls[0]![0].text.format;
    const moves = schema.schema.properties.move.enum as string[];
    expect(moves.sort()).toEqual([...open.strategy.moves].sort());
  });

  it("constrains target_field to the declared evidence contract", async () => {
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open, state(), {});
    const schema = client.responses.parse.mock.calls[0]![0].text.format.schema;
    // Nullable, so the enum members sit inside the union the SDK emits.
    expect(JSON.stringify(schema.properties.target_field))
      .toContain("target_program");
    expect(JSON.stringify(schema.properties.target_field))
      .not.toContain("favourite_colour");
  });

  it("puts the spec-derived prompt in instructions and the conversation in input", async () => {
    // The caching discipline: stable prefix first, volatile last. Reversing them
    // silently costs money on every turn of every conversation.
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open,
      state({ turns: [turn("lead", "when are the intakes?")] }), {});
    const call = client.responses.parse.mock.calls[0]![0];
    expect(call.instructions).toContain("MOVES");
    expect(call.instructions).not.toContain("when are the intakes?");
    expect(call.input).toContain("when are the intakes?");
    expect(call.prompt_cache_key).toBe(`${open.journey}@${open.version}`);
  });

  it("tells the planner the facts it may state, and nothing more", async () => {
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open, state(), {});
    const instructions = client.responses.parse.mock.calls[0]![0].instructions as string;
    expect(instructions).toContain(open.knowledge.intakes);
    expect(instructions).toMatch(/Never improvise a fact/i);
  });

  it("honours the journey's declared reasoning effort", async () => {
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open, state(), {});
    expect(client.responses.parse.mock.calls[0]![0].reasoning)
      .toEqual({ effort: open.strategy.reasoning_effort });
  });

  it("reports recent moves so the planner can see its own overrides", async () => {
    const client = reply(good);
    await new ModelPlanner(client as never).plan(open, state({
      moves: [{
        move: "ask", proposed: "close", overridden: true,
        rule: "close_without_required_evidence", rationale: "", at: new Date(),
      }],
    }), {});
    expect(client.responses.parse.mock.calls[0]![0].input)
      .toContain("close -> ask (close_without_required_evidence)");
  });

  it("throws rather than guessing when the model returns nothing structured", async () => {
    const client = reply(null);
    await expect(new ModelPlanner(client as never).plan(open, state(), {}))
      .rejects.toThrow(/no structured output/i);
  });
});
