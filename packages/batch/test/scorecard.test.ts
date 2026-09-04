import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { Persona } from "../src/simulate/persona.js";
import { scoreConversation, undetectableRules } from "../src/eval/scorecard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const persona: Persona = {
  id: "p1",
  truth: { target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" },
  verbosity: "normal", cooperation: 1, objection: "none",
  dropoffAfterTurn: null, mood: "neutral",
};

const state = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "sim_1", journey: spec.journey, journeyVersion: 4,
  evidence: {}, turns: [], outcomes: [], ...over,
});

const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });

describe("scoreConversation", () => {
  it("scores full completeness when every required field is established", () => {
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" }),
      decision: "hot",
    }), persona);
    expect(c.evidenceCompleteness).toBe(1);
    expect(c.evidenceCorrectness).toBe(1);
    expect(c.hallucinatedFields).toEqual([]);
  });

  it("scores partial completeness proportionally", () => {
    const c = scoreConversation(spec, state({ evidence: ev({ timeline: "this_intake" }) }), persona);
    expect(c.evidenceCompleteness).toBeCloseTo(1 / 3, 5);
  });

  it("catches a hallucinated value that contradicts ground truth", () => {
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "online_mba", timeline: "this_intake", budget_band: "above_15L" }),
    }), persona);
    expect(c.hallucinatedFields).toEqual(["target_program"]);
    expect(c.evidenceCorrectness).toBeCloseTo(2 / 3, 5);
  });

  it("returns null correctness when nothing was extracted", () => {
    expect(scoreConversation(spec, state(), persona).evidenceCorrectness).toBeNull();
  });

  it("ignores extracted fields the persona has no truth for", () => {
    const c = scoreConversation(spec, state({
      evidence: ev({ target_program: "executive_mba", timeline: "this_intake",
                     budget_band: "above_15L", decision_maker: "self" }),
    }), persona);
    expect(c.evidenceCorrectness).toBe(1);
    expect(c.hallucinatedFields).toEqual([]);
  });

  it("detects a policy violation in an agent message", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("agent", "The fee is exactly ₹12,50,000 for this programme")],
    }), persona);
    expect(c.policyViolations.map((v) => v.rule)).toContain("quote_exact_fees");
  });

  it("detects an admission promise", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("agent", "You are guaranteed admission with that profile")],
    }), persona);
    expect(c.policyViolations.map((v) => v.rule)).toContain("promise_admission");
  });

  it("never charges the agent for what the LEAD said", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("lead", "can you guarantee admission and tell me the exact fee of 12,50,000?")],
    }), persona);
    expect(c.policyViolations).toEqual([]);
  });

  it("classifies outcomes", () => {
    expect(scoreConversation(spec, state({ decision: "hot" }), persona).outcome).toBe("completed");
    const s = state({ turns: [turn("agent", "hi")] });
    expect(scoreConversation(spec, s, persona, { escalated: true }).outcome).toBe("escalated");
    expect(scoreConversation(spec, s, persona, { ghosted: true }).outcome).toBe("ghosted");
    expect(scoreConversation(spec, s, persona).outcome).toBe("exhausted");
  });

  it("counts only the lead's turns as turns used", () => {
    const c = scoreConversation(spec, state({
      turns: [turn("agent", "a"), turn("lead", "b"), turn("agent", "c"), turn("lead", "d")],
    }), persona);
    expect(c.turnsUsed).toBe(2);
  });

  it("lists rules that need a judge because no detector exists", () => {
    expect(undetectableRules(spec)).toContain("compare_to_competitors");
    expect(undetectableRules(spec)).not.toContain("quote_exact_fees");
  });
});
