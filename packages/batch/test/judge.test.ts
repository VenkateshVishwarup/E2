import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { ConversationJudge, attachJudgement } from "../src/eval/judge.js";
import type { Scorecard } from "../src/eval/scorecard.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const state: LeadState = {
  leadId: "sim_1", journey: spec.journey, journeyVersion: 4,
  evidence: {}, outcomes: [],
  turns: [
    { role: "agent", text: "Hi, which programme are you considering?", at: new Date() },
    { role: "lead", text: "executive mba", at: new Date() },
  ],
};

const card: Scorecard = {
  leadId: "sim_1", personaId: "p1", evidenceCompleteness: 0.33,
  evidenceCorrectness: 1, hallucinatedFields: [], policyViolations: [],
  turnsUsed: 1, outcome: "completed", qualified: false,
};

const VERDICT = { naturalness: 4, questionQuality: 5, policyBreaches: [], notes: "Concise." };

const fake = (parsed: unknown) =>
  ({ responses: { parse: vi.fn().mockResolvedValue({ output_parsed: parsed }) } });

describe("ConversationJudge", () => {
  it("returns the judged dimensions", async () => {
    const j = await new ConversationJudge(fake(VERDICT) as never).judge(spec, state, card);
    expect(j.naturalness).toBe(4);
    expect(j.questionQuality).toBe(5);
    expect(j.policyBreaches).toEqual([]);
  });

  it("judges at high effort with the profile's judge model", async () => {
    const client = fake(VERDICT);
    await new ConversationJudge(client as never).judge(spec, state, card);
    const req = client.responses.parse.mock.calls[0]![0] as {
      model: string; reasoning: { effort: string };
    };
    // dev profile: terra everywhere. The judge-strength invariant is enforced
    // separately in provider.test.ts, not by pinning an id here.
    expect(req.model).toBe("gpt-5.6-terra");
    expect(req.reasoning.effort).toBe("high");
  });

  it("asks only about rules the deterministic detectors cannot settle", async () => {
    const client = fake(VERDICT);
    await new ConversationJudge(client as never).judge(spec, state, card);
    const sent = JSON.stringify(client.responses.parse.mock.calls[0]![0]);
    expect(sent).toContain("compare_to_competitors");
    // Already settled by regex - do not pay a model to redo it.
    expect(sent).not.toContain("quote_exact_fees");
  });

  it("passes the mechanical findings so the judge is not re-deriving them", async () => {
    const client = fake(VERDICT);
    await new ConversationJudge(client as never).judge(spec, state, card);
    const req = client.responses.parse.mock.calls[0]![0] as { input: string };
    expect(JSON.parse(req.input).mechanical_findings.evidenceCompleteness).toBe(0.33);
  });

  it("throws when the model returns no structured output", async () => {
    await expect(new ConversationJudge(fake(null) as never).judge(spec, state, card))
      .rejects.toThrow(/structured output/i);
  });

  it("attaches a judgement onto a scorecard without mutating it", () => {
    const judged = attachJudgement(card, VERDICT);
    expect(judged.judgement).toEqual(VERDICT);
    expect(judged.leadId).toBe("sim_1");
    expect(card).not.toHaveProperty("judgement");
  });
});
