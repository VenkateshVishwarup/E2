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
  evidence: {}, turns: [], outcomes: [], moves: [], ...over,
});

const turn = (role: "agent" | "lead", text: string) => ({ role, text, at: new Date() });
const ev = (o: Record<string, string>) =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

const extractor = (evidence: Record<string, { value: unknown; confidence: number }> = {}) =>
  ({ extract: vi.fn().mockResolvedValue(evidence) }) as never;

const asker = (text: string) =>
  ({ responses: { create: vi.fn().mockResolvedValue({ output_text: text }) } });

const callsOf = (a: ReturnType<typeof asker>) => a.responses.create.mock.calls;

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

  it("never asks a follow-up when allowFollowUp is false", async () => {
    // Replay runs against a finished transcript - there is no lead to answer,
    // so a question would be a wasted model call producing nothing.
    const s = state({ turns: [turn("agent", "hi"), turn("lead", "exec mba")] });
    const a = asker("should not be used");
    const rt = new AgentRuntime(extractor(ev({ target_program: "executive_mba" })), a as never);
    const actions = await rt.step(spec, s, { allowFollowUp: false });

    expect(callsOf(a)).toHaveLength(0);
    expect(actions.map((x) => x.kind)).toEqual(["extract", "complete"]);
    expect(actions.at(-1)).toEqual({ kind: "complete", qualified: false });
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

describe("AgentRuntime.step — sentiment escalation", () => {
  it("escalates a frustrated lead on the declared sentiment rule", async () => {
    const s = state({ turns: [
      turn("agent", "Which programme?"),
      turn("lead", "this is terrible, useless, awful — waste of time"),
    ] });
    const actions = await new AgentRuntime(extractor(), asker("x") as never).step(spec, s);
    expect(actions.find((a) => a.kind === "escalate"))
      .toMatchObject({ reason: "sentiment < -0.5" });
  });

  it("does not escalate a merely neutral lead", async () => {
    const s = state({ turns: [turn("agent", "Which programme?"), turn("lead", "executive mba")] });
    const actions = await new AgentRuntime(
      extractor(ev({ target_program: "executive_mba" })), asker("next?") as never,
    ).step(spec, s);
    expect(actions.some((a) => a.kind === "escalate")).toBe(false);
  });
});

// ─── The open strategy ───────────────────────────────────────────────────────

const openSpec = parseSpec(
  readFileSync(join(HERE, "../../core/test/fixtures/mba-v7-open.yaml"), "utf8"),
);

const openState = (over: Partial<LeadState> = {}): LeadState => ({
  leadId: "L1", journey: openSpec.journey, journeyVersion: openSpec.version,
  evidence: {}, turns: [], outcomes: [], moves: [], ...over,
});

/** A planner that proposes whatever the test wants, without a model. */
const planner = (proposal: Record<string, unknown>) => ({
  plan: vi.fn().mockResolvedValue({
    move: "ask", rationale: "r", message: "m",
    targetField: null, knowledgeKey: null, capability: null, confidence: 0.8,
    ...proposal,
  }),
});

const runtimeFor = (
  p: ReturnType<typeof planner>,
  evidence: Record<string, { value: unknown; confidence: number }> = {},
  askText = "generated question",
) => new AgentRuntime(extractor(evidence), asker(askText) as never, p as never);

const kinds = (actions: Awaited<ReturnType<AgentRuntime["step"]>>) => actions.map((a) => a.kind);
const findMove = (actions: Awaited<ReturnType<AgentRuntime["step"]>>) =>
  actions.find((a) => a.kind === "move") as
    | Extract<Awaited<ReturnType<AgentRuntime["step"]>>[number], { kind: "move" }>
    | undefined;

describe("AgentRuntime.step — open strategy", () => {
  const started = { turns: [turn("agent", "hi"), turn("lead", "tell me about intakes")] };

  it("still opens with the pinned disclosure and no model call", async () => {
    // Disclosure is a commitment to the lead, not a decision the agent gets to make.
    const p = planner({});
    const actions = await runtimeFor(p).step(openSpec, openState());
    expect(actions).toHaveLength(1);
    expect(actions[0]).toMatchObject({ kind: "send", pinnedTemplate: "templates/wa_mba_optin_v4" });
    expect(p.plan).not.toHaveBeenCalled();
  });

  it("still escalates on an explicit request for a human, without planning", async () => {
    const p = planner({ move: "acknowledge", message: "no need!" });
    const actions = await runtimeFor(p).step(openSpec,
      openState({ turns: [turn("agent", "hi"), turn("lead", "put me through to a human")] }));
    expect(actions).toEqual([{ kind: "escalate", reason: "asks_for_human" }]);
    expect(p.plan).not.toHaveBeenCalled();
  });

  it("still honours a declared escalation trigger over the planner", async () => {
    const p = planner({ move: "ask", targetField: "timeline", message: "when?" });
    const actions = await runtimeFor(p, ev({ budget_band: "needs_financing" }))
      .step(openSpec, openState(started));
    expect(actions.map((a) => a.kind)).toContain("escalate");
    expect(p.plan).not.toHaveBeenCalled();
  });

  it("still stops at the turn budget", async () => {
    const p = planner({});
    const turns = Array.from({ length: openSpec.policy.max_turns },
      (_, i) => turn(i % 2 === 0 ? "agent" : "lead", "x"));
    const actions = await runtimeFor(p).step(openSpec, openState({ turns }));
    expect(actions).toEqual([{ kind: "complete", qualified: false }]);
    expect(p.plan).not.toHaveBeenCalled();
  });

  it("records the decision before the actions that carry it out", async () => {
    const p = planner({ move: "ask", targetField: "timeline", message: "Which intake?" });
    const actions = await runtimeFor(p).step(openSpec, openState(started));
    expect(kinds(actions)).toEqual(["move", "send"]);
  });

  it("sends the planner's own wording when the move was admitted", async () => {
    const p = planner({ move: "ask", targetField: "timeline", message: "Which intake?" });
    const a = asker("should not be used");
    const actions = await new AgentRuntime(extractor(), a as never, p as never)
      .step(openSpec, openState(started));
    expect(actions).toContainEqual({ kind: "send", text: "Which intake?" });
    expect(callsOf(a)).toHaveLength(0);
  });

  it("writes its own question when the move was overridden", async () => {
    // Whatever the planner wrote was for a different move, so reusing it would
    // put an answer's framing on a question.
    const p = planner({ move: "close", message: "Lovely speaking with you." });
    const a = asker("And which intake are you aiming for?");
    const actions = await new AgentRuntime(extractor(), a as never, p as never)
      .step(openSpec, openState(started));
    expect(findMove(actions)).toMatchObject({
      proposed: "close", move: "ask", overridden: true,
      rule: "close_without_required_evidence",
    });
    expect(actions).toContainEqual({ kind: "send", text: "And which intake are you aiming for?" });
  });

  it("appends the declared fact to an admitted answer", async () => {
    const p = planner({ move: "answer", knowledgeKey: "intakes", message: "Sure." });
    const actions = await runtimeFor(p).step(openSpec, openState(started));
    const sent = actions.find((x) => x.kind === "send") as { text: string };
    expect(sent.text).toBe(`Sure. ${openSpec.knowledge.intakes}`);
  });

  it("scores and routes through the same path as the scripted strategy", async () => {
    const complete = ev({
      target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L",
      decision_maker: "self",
    });
    const p = planner({ move: "close", message: "" });
    const actions = await runtimeFor(p, complete).step(openSpec, openState(started));
    expect(kinds(actions)).toEqual(["extract", "move", "score", "route", "complete"]);
    expect(actions).toContainEqual({ kind: "score", score: 80 });
    expect(actions).toContainEqual({ kind: "complete", qualified: true });
  });

  it("escalates on the planner's judgement under a countable reason", async () => {
    const p = planner({ move: "escalate", message: "", rationale: "they sound upset" });
    const actions = await runtimeFor(p).step(openSpec, openState(started));
    expect(actions).toContainEqual({ kind: "escalate", reason: "agent_judgement" });
    expect(findMove(actions)?.rationale).toBe("they sound upset");
  });

  it("emits an invoke for the caller rather than reaching the broker itself", async () => {
    const p = planner({
      move: "offer", capability: "catalog.lookup_program", message: "Let me look.",
    });
    const actions = await runtimeFor(p, ev({ target_program: "online_mba" }))
      .step(openSpec, openState(started), { toolsAvailable: true });
    expect(kinds(actions)).toEqual(["extract", "move", "send", "invoke"]);
  });

  it("refuses an offer no caller can perform", async () => {
    const p = planner({
      move: "offer", capability: "catalog.lookup_program", message: "Let me look.",
    });
    const actions = await runtimeFor(p).step(openSpec, openState(started));
    expect(kinds(actions)).not.toContain("invoke");
    expect(findMove(actions)).toMatchObject({ overridden: true, rule: "offer_without_binding" });
  });

  it("does not plan a reply during replay, and still reaches a decision", async () => {
    // A finished transcript has no lead left to react to, so planning would burn
    // a call and change nothing — but the comparison that matters still runs.
    const complete = ev({
      target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L",
    });
    const p = planner({ move: "ask", targetField: "timeline", message: "?" });
    const actions = await runtimeFor(p, complete)
      .step(openSpec, openState(started), { allowFollowUp: false });
    expect(p.plan).not.toHaveBeenCalled();
    expect(kinds(actions)).toEqual(["extract", "score", "route", "complete"]);
  });

  it("does not claim a decision during replay when the transcript was inconclusive", async () => {
    const p = planner({});
    const actions = await runtimeFor(p, ev({ target_program: "online_mba" }))
      .step(openSpec, openState(started), { allowFollowUp: false });
    expect(kinds(actions)).toEqual(["extract", "complete"]);
    expect(actions).toContainEqual({ kind: "complete", qualified: false });
  });
});

describe("AgentRuntime.step — the scripted strategy is untouched", () => {
  it("never plans, and never records a move", async () => {
    const p = planner({ move: "acknowledge", message: "hmm" });
    const actions = await runtimeFor(p, ev({ target_program: "online_mba" }))
      .step(spec, state({ turns: [turn("agent", "hi"), turn("lead", "the online one")] }));
    expect(p.plan).not.toHaveBeenCalled();
    expect(actions.map((a) => a.kind)).not.toContain("move");
  });
});

describe("AgentRuntime.step — a question that is not landing", () => {
  const asked = (field: string) => ({
    move: "ask", proposed: "ask", overridden: false, rule: null,
    rationale: "", targetField: field, at: new Date(),
  });

  it("escalates under the guardrail's rule, not as the agent's own judgement", async () => {
    const p = planner({ move: "ask", targetField: "timeline", message: "Timeline?" });
    const actions = await runtimeFor(p, ev({
      target_program: "online_mba", budget_band: "5L_to_15L",
      decision_maker: "self", prior_qualification: "B.Tech",
    })).step(openSpec, openState({
      turns: [turn("agent", "hi"), turn("lead", "dunno")],
      moves: [asked("timeline"), asked("timeline")],
    }));
    expect(actions).toContainEqual({ kind: "escalate", reason: "ask_repeated" });
  });

  it("moves on to another field instead of asking a third time", async () => {
    const p = planner({ move: "ask", targetField: "timeline", message: "Timeline?" });
    const a = asker("And roughly what budget are you working with?");
    const actions = await new AgentRuntime(extractor(ev({ target_program: "online_mba" })),
      a as never, p as never).step(openSpec, openState({
        turns: [turn("agent", "hi"), turn("lead", "dunno")],
        moves: [asked("timeline"), asked("timeline")],
      }));
    expect(findMove(actions)).toMatchObject({
      overridden: true, rule: "ask_repeated", targetField: "budget_band",
    });
    expect(actions).toContainEqual({ kind: "send", text: "And roughly what budget are you working with?" });
  });
});
