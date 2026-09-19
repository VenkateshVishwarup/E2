import { describe, it, expect } from "vitest";
import { actionsToEvents, type EventBase } from "../src/persist.js";
import type { Action } from "../src/step.js";

const base: EventBase = {
  leadId: "L1", journey: "mba-admissions-qualification", journeyVersion: 7,
  agentId: "agent://engati/mba-admissions",
};

const apply = (actions: Action[]) => actionsToEvents(actions, base, "web");
const typesOf = (actions: Action[]) => apply(actions).events.map((e) => e.type);

const MOVE: Extract<Action, { kind: "move" }> = {
  kind: "move", move: "ask", proposed: "close", overridden: true,
  rule: "close_without_required_evidence", rationale: "felt finished",
  confidence: 0.7, targetField: "timeline", knowledgeKey: null,
};

describe("actionsToEvents — planner decisions", () => {
  it("records a MoveChosen for every decision, admitted or not", () => {
    expect(typesOf([MOVE, { kind: "send", text: "Which intake?" }]))
      .toEqual(["MoveChosen", "MessageSent"]);
  });

  it("keeps both what was proposed and what happened", () => {
    // The pair IS the audit trail. Storing only the outcome loses the disagreement.
    const [event] = apply([MOVE]).events;
    expect(event!.payload).toMatchObject({
      move: "ask", proposed: "close", overridden: true,
      rule: "close_without_required_evidence", rationale: "felt finished",
    });
  });

  it("surfaces the decision to the caller as well as to the log", () => {
    expect(apply([MOVE]).move).toEqual({
      move: "ask", proposed: "close", overridden: true,
      rule: "close_without_required_evidence", rationale: "felt finished",
    });
  });

  it("reports no move for a scripted turn", () => {
    expect(apply([{ kind: "send", text: "hi" }]).move).toBeNull();
  });

  it("carries a tool call to the caller without writing an event for it", () => {
    // The broker is the single egress point and writes its own events. Two
    // authorities on one decision is how an audit trail starts disagreeing
    // with itself.
    const applied = apply([
      { kind: "send", text: "Let me look that up." },
      { kind: "invoke", capability: "catalog.lookup_program", args: { target_program: "online_mba" } },
    ]);
    expect(applied.events.map((e) => e.type)).toEqual(["MessageSent"]);
    expect(applied.invocations).toEqual([
      { capability: "catalog.lookup_program", args: { target_program: "online_mba" } },
    ]);
  });

  it("reports no invocations for a turn that used no tool", () => {
    expect(apply([{ kind: "send", text: "hi" }]).invocations).toEqual([]);
  });
});
