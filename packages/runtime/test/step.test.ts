import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { AgentRuntime } from "../src/step.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const state = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "L1", journey: spec.journey, journeyVersion: spec.version,
  evidence: {}, turns: [], outcomes: [], ...over,
});

const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });
const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

const extractor = (evidence: Record<string, { value: unknown; confidence: number }> = {}) =>
  ({ extract: vi.fn().mockResolvedValue(evidence) }) as never;

const asker = (text: string) =>
  ({ messages: { create: vi.fn().mockResolvedValue({ content: [{ type: "text", text }] }) } });

const callsOf = (a: ReturnType<typeof asker>) => a.messages.create.mock.calls;

describe("AgentRuntime.step", () => {
  it("opens with the pinned template and the AI disclosure", async () => {
    const actions = await new AgentRuntime(extractor(), asker("unused") as never).step(spec, state());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", pinnedTemplate: "templates/wa_mba_optin_v4" });
    expect((actions[0] as { text: string }).text).toContain("AI assistant");
  });

  it("does not call the model on first contact", async () => {
    const a = asker("should not be used");
    await new AgentRuntime(extractor(), a as never).step(spec, state());
    expect(callsOf(a)).toHaveLength(0);
  });

  it("escalates when the lead asks for a human", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "can I speak to a human please")] });
    const actions = await new AgentRuntime(extractor(), asker("x") as never).step(spec, s);
    expect(actions.some((a) => a.kind === "escalate")).toBe(true);
  });

  it("escalates when declared evidence triggers it", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "need a loan")] });
    const rt = new AgentRuntime(extractor(ev({ budget_band: "needs_financing" })), asker("x") as never);
    const actions = await rt.step(spec, s);
    expect(actions.find((a) => a.kind === "escalate"))
      .toMatchObject({ reason: expect.stringContaining("budget_band") });
  });

  it("completes as unqualified once max_turns is exhausted", async () => {
    const turns = Array.from({ length: 14 }, (_, i) =>
      turn(i % 2 === 0 ? "agent" : "lead", `t${i}`));
    const actions = await new AgentRuntime(extractor(), asker("x") as never).step(spec, state({ turns }));
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: false });
  });

  it("scores, routes and completes once required evidence is established", async () => {
    // 30 (this_intake) + 25 (above_15L) + 15 (self) + 10 (target_program.*) = 80 -> hot
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba, this intake, 20L budget, my call")] });
    const rt = new AgentRuntime(
      extractor(ev({
        target_program: "executive_mba", timeline: "this_intake",
        budget_band: "above_15L", decision_maker: "self",
      })),
      asker("x") as never,
    );
    const actions = await rt.step(spec, s);
    expect(actions.map((a) => a.kind)).toEqual(["extract", "score", "route", "complete"]);
    expect(actions.find((a) => a.kind === "score")).toMatchObject({ score: 80 });
    expect(actions.find((a) => a.kind === "route")).toMatchObject({ decision: "hot" });
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: true });
  });

  it("completes UNqualified when required evidence is complete but the score falls short", async () => {
    // Only the three required fields: 30 + 25 + 10 = 65. Below the hot cut of 70.
    // qualifies_when is "score >= 70 AND evidence.complete(required)" - completeness
    // alone must not qualify a lead.
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba, this intake, 20L budget")] });
    const rt = new AgentRuntime(
      extractor(ev({ target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L" })),
      asker("x") as never,
    );
    const actions = await rt.step(spec, s);
    expect(actions.find((a) => a.kind === "score")).toMatchObject({ score: 65 });
    expect(actions.find((a) => a.kind === "route")).toMatchObject({ decision: "warm" });
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: false });
  });

  it("asks for the next missing field, and never re-asks an established one", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba")] });
    const a = asker("Are you looking at this intake or the next one?");
    const rt = new AgentRuntime(extractor(ev({ target_program: "executive_mba" })), a as never);
    const actions = await rt.step(spec, s);

    expect(actions.map((x) => x.kind)).toEqual(["extract", "send"]);
    const prompt = JSON.stringify(callsOf(a)[0]![0]);
    expect(prompt).toContain("timeline");
    expect(prompt).not.toContain('\\"field\\":\\"target_program\\"');
  });

  it("defers sensitive fields until something else is established", async () => {
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "hello")] });
    const a = asker("Which programme are you considering?");
    await new AgentRuntime(extractor(), a as never).step(spec, s);
    const prompt = JSON.stringify(callsOf(a)[0]![0]);
    expect(prompt).toContain("target_program");
    expect(prompt).not.toContain("budget_band");
  });
});
