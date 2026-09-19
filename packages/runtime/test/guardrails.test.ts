import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, type JourneySpec } from "@midfunnel/core/journey/spec";
import type { MoveRecord } from "@midfunnel/core/events/types";
import {
  admit, deflectionStreak, exhaustedFields, type GuardrailContext, type MoveProposal,
} from "../src/guardrails.js";
import type { Evidence } from "../src/scoring.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../core/test/fixtures");
const open = parseSpec(readFileSync(join(FIXTURES, "mba-v7-open.yaml"), "utf8"));

/** A spec with one field changed, so a test does not need its own YAML file. */
function variant(over: (s: JourneySpec) => void): JourneySpec {
  const copy = parseSpec(readFileSync(join(FIXTURES, "mba-v7-open.yaml"), "utf8"));
  over(copy);
  return copy;
}

const propose = (over: Partial<MoveProposal> = {}): MoveProposal => ({
  move: "ask", rationale: "because", message: "What programme?",
  targetField: "target_program", knowledgeKey: null, capability: null, confidence: 0.8,
  ...over,
});

const ev = (o: Record<string, string>): Evidence =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v, confidence: 0.9 }]));

const ALL_REQUIRED = ev({
  target_program: "executive_mba", timeline: "this_intake", budget_band: "5L_to_15L",
});

const ctx = (over: Partial<GuardrailContext> = {}): GuardrailContext => ({
  evidence: {}, moves: [], toolsAvailable: true, ...over,
});

const move = (m: string): MoveRecord =>
  ({ move: m, proposed: m, overridden: false, rule: null, rationale: "", targetField: null, at: new Date() });

describe("deflectionStreak", () => {
  it("counts consecutive non-collecting moves from the end", () => {
    expect(deflectionStreak([move("ask"), move("answer"), move("acknowledge")])).toBe(2);
  });
  it("resets on an ask", () => {
    expect(deflectionStreak([move("answer"), move("answer"), move("ask")])).toBe(0);
  });
  it("is zero for an empty log", () => {
    expect(deflectionStreak([])).toBe(0);
  });
  it("ignores what a blocked deflection proposed, only what happened", () => {
    // The guardrail already turned this into an ask. Counting the proposal would
    // punish the agent twice for one mistake.
    const blocked: MoveRecord = {
      move: "ask", proposed: "acknowledge", overridden: true,
      rule: "deflections_exhausted", rationale: "", targetField: null, at: new Date(),
    };
    expect(deflectionStreak([move("answer"), blocked])).toBe(0);
  });
});

describe("admit — a move the journey does not allow", () => {
  it("is overridden, whatever it is", () => {
    const only = variant((s) => { s.strategy.moves = ["ask", "close"]; });
    const d = admit(only, propose({ move: "acknowledge", message: "mm-hmm" }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "move_not_permitted", move: "ask" });
  });

  it("records what was proposed even though it was refused", () => {
    const only = variant((s) => { s.strategy.moves = ["ask", "close"]; });
    const d = admit(only, propose({ move: "offer", capability: "crm.upsert_lead" }), ctx());
    expect(d.proposed).toBe("offer");
  });

  it("refuses a word that is not a move at all", () => {
    const d = admit(open, propose({ move: "improvise" }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "move_not_permitted" });
  });
});

describe("admit — escalate", () => {
  it("is never second-guessed", () => {
    // A guardrail that can override an escalation is a guardrail that can trap
    // someone in a bot.
    const d = admit(open, propose({ move: "escalate", message: "" }), ctx());
    expect(d).toMatchObject({ move: "escalate", overridden: false, rule: null });
  });
});

describe("admit — close", () => {
  it("is admitted once required evidence is complete", () => {
    const d = admit(open, propose({ move: "close", message: "" }), ctx({ evidence: ALL_REQUIRED }));
    expect(d).toMatchObject({ move: "close", overridden: false, message: null });
  });

  it("is refused while required evidence is missing", () => {
    const d = admit(open, propose({ move: "close", message: "" }),
      ctx({ evidence: ev({ target_program: "online_mba" }) }));
    expect(d).toMatchObject({
      move: "ask", overridden: true, rule: "close_without_required_evidence",
    });
  });

  it("falls back to the field the scripted strategy would have chosen", () => {
    // Not an arbitrary substitute: the two strategies must stay comparable at
    // exactly the moments the open one goes wrong.
    const d = admit(open, propose({ move: "close", message: "" }),
      ctx({ evidence: ev({ target_program: "online_mba" }) }));
    expect(d.targetField).toBe("timeline");
  });

  it("is allowed early when the journey opts in", () => {
    const loose = variant((s) => { s.strategy.allow_unscripted_close = true; });
    const d = admit(loose, propose({ move: "close", message: "" }), ctx());
    expect(d).toMatchObject({ move: "close", overridden: false });
  });

  it("sends nothing, exactly as the scripted path does", () => {
    const d = admit(open, propose({ move: "close", message: "Thanks, bye!" }),
      ctx({ evidence: ALL_REQUIRED }));
    expect(d.message).toBeNull();
  });
});

describe("admit — answer", () => {
  it("appends the declared fact verbatim after the model's framing", () => {
    const d = admit(open, propose({
      move: "answer", knowledgeKey: "intakes", message: "Good question.", targetField: null,
    }), ctx());
    expect(d.overridden).toBe(false);
    expect(d.message).toBe(`Good question. ${open.knowledge.intakes}`);
  });

  it("sends the fact alone when there is no framing", () => {
    const d = admit(open, propose({
      move: "answer", knowledgeKey: "intakes", message: "", targetField: null,
    }), ctx());
    expect(d.message).toBe(open.knowledge.intakes);
  });

  it("refuses a knowledge key the journey never declared", () => {
    const d = admit(open, propose({
      move: "answer", knowledgeKey: "parking", message: "Sure.", targetField: null,
    }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "answer_without_knowledge" });
  });

  it("deflects rather than changing the subject when it cannot answer", () => {
    // Changing the subject when someone asks you something is the exact failure
    // the open strategy exists to fix.
    const d = admit(open, propose({
      move: "answer", knowledgeKey: null, message: "Sure.", targetField: null,
    }), ctx());
    expect(d.move).toBe("acknowledge");
    expect(d.message).toContain("counsellor");
  });

  it("uses the tenant's own deflection line when one is pinned", () => {
    const d = admit(open, propose({ move: "answer", knowledgeKey: null, message: "" }), ctx());
    expect(d.message).toBe(String(open.pinned.deflection));
  });

  it("falls back to a default line when the journey pinned none", () => {
    const bare = variant((s) => { delete s.pinned.deflection; });
    const d = admit(bare, propose({ move: "answer", knowledgeKey: null, message: "" }), ctx());
    expect(d.message).toMatch(/don't want to guess/i);
  });

  it("strips a framing that quotes a figure, and keeps the fact", () => {
    // The framing is the model's and is constrained; the fact is the tenant's
    // and is not. A journey may certainly declare its own fee.
    const d = admit(open, propose({
      move: "answer", knowledgeKey: "fees", message: "It's about ₹12 lakh.", targetField: null,
    }), ctx());
    expect(d).toMatchObject({ move: "answer", overridden: true, rule: "answer_quoted_a_figure" });
    expect(d.message).toBe(open.knowledge.fees);
  });

  it("leaves the framing alone when the journey permits quoting", () => {
    const permissive = variant((s) => {
      s.policy.never = s.policy.never.filter((r) => r !== "quote_exact_fees");
    });
    const d = admit(permissive, propose({
      move: "answer", knowledgeKey: "fees", message: "Roughly ₹12 lakh.", targetField: null,
    }), ctx());
    expect(d.overridden).toBe(false);
    expect(d.message).toContain("₹12 lakh");
  });

  it("attributes the override to the deflection cap when that is what decided it", () => {
    const d = admit(open, propose({ move: "answer", knowledgeKey: null, message: "" }),
      ctx({ moves: [move("answer"), move("acknowledge")] }));
    expect(d).toMatchObject({ move: "ask", rule: "deflections_exhausted" });
  });
});

describe("admit — acknowledge", () => {
  it("is admitted inside the deflection budget", () => {
    const d = admit(open, propose({ move: "acknowledge", message: "Understood.", targetField: null }),
      ctx({ moves: [move("ask")] }));
    expect(d).toMatchObject({ move: "acknowledge", overridden: false });
  });

  it("is refused once the budget is spent", () => {
    const d = admit(open, propose({ move: "acknowledge", message: "Understood.", targetField: null }),
      ctx({ moves: [move("answer"), move("acknowledge")] }));
    expect(d).toMatchObject({
      move: "ask", overridden: true, rule: "deflections_exhausted",
    });
  });

  it("is refused when it would say nothing", () => {
    const d = admit(open, propose({ move: "acknowledge", message: "   ", targetField: null }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "empty_message" });
  });
});

describe("admit — offer", () => {
  it("is admitted for a declared, privileged capability", () => {
    const d = admit(open, propose({
      move: "offer", capability: "catalog.lookup_program",
      message: "Let me pull that up.", targetField: null,
    }), ctx());
    expect(d).toMatchObject({ move: "offer", overridden: false });
  });

  it("is refused for a capability the journey declares no tool for", () => {
    const d = admit(open, propose({
      move: "offer", capability: "payments.refund", message: "One moment.", targetField: null,
    }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "offer_without_binding" });
  });

  it("is refused when the agent holds no privilege, before the broker is troubled", () => {
    const unprivileged = variant((s) => {
      s.agent.privileges = s.agent.privileges.filter((p) => !p.startsWith("calendar.book_slot"));
    });
    const d = admit(unprivileged, propose({
      move: "offer", capability: "calendar.book_slot", message: "Booking now.", targetField: null,
    }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "offer_without_privilege" });
  });

  it("is refused when the caller cannot perform it", () => {
    // Otherwise the agent promises a lead something nothing will carry out.
    const d = admit(open, propose({
      move: "offer", capability: "catalog.lookup_program",
      message: "Let me check.", targetField: null,
    }), ctx({ toolsAvailable: false }));
    expect(d).toMatchObject({ overridden: true, rule: "offer_without_binding" });
  });
});

describe("admit — ask", () => {
  it("is admitted for a declared, unestablished field", () => {
    const d = admit(open, propose(), ctx());
    expect(d).toMatchObject({ move: "ask", overridden: false, targetField: "target_program" });
    expect(d.message).toBe("What programme?");
  });

  it("refuses a field the evidence contract never declared", () => {
    const d = admit(open, propose({ targetField: "favourite_colour" }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "ask_unknown_field" });
  });

  it("refuses to ask again for something already established", () => {
    const d = admit(open, propose({ targetField: "target_program" }),
      ctx({ evidence: ev({ target_program: "online_mba" }) }));
    expect(d).toMatchObject({ overridden: true, rule: "ask_already_established" });
    expect(d.targetField).toBe("timeline");
  });

  it("refuses to open with a sensitive field", () => {
    // You do not open with money.
    const d = admit(open, propose({ targetField: "budget_band", message: "Your budget?" }), ctx());
    expect(d).toMatchObject({ overridden: true, rule: "ask_sensitive_too_early" });
    expect(d.targetField).not.toBe("budget_band");
  });

  it("allows a sensitive field once something is established", () => {
    const d = admit(open, propose({ targetField: "budget_band", message: "And your budget?" }),
      ctx({ evidence: ev({ target_program: "online_mba" }) }));
    expect(d).toMatchObject({ move: "ask", overridden: false, targetField: "budget_band" });
  });

  it("becomes a close when there is nothing left to ask", () => {
    const everything = ev({
      target_program: "executive_mba", timeline: "this_intake", budget_band: "above_15L",
      decision_maker: "self", prior_qualification: "B.Tech",
    });
    const d = admit(open, propose({ targetField: "timeline" }), ctx({ evidence: everything }));
    expect(d).toMatchObject({ move: "close", overridden: true });
  });
});

describe("admit — the override needs its own text", () => {
  it("returns a null message so the runtime writes the question for the right field", () => {
    // Whatever the planner wrote was for a different move and cannot be reused.
    const d = admit(open, propose({ move: "close", message: "Lovely talking to you!" }), ctx());
    expect(d.move).toBe("ask");
    expect(d.message).toBeNull();
  });
});

describe("admit — nothing is admissible", () => {
  it("hands to a human rather than inventing a move", () => {
    const stuck = variant((s) => { s.strategy.moves = ["answer"]; });
    const d = admit(stuck, propose({ move: "answer", knowledgeKey: null, message: "" }), ctx());
    expect(d.move).toBe("escalate");
  });
});

describe("admit — a question that is not landing", () => {
  const asked = (field: string): MoveRecord =>
    ({ ...move("ask"), targetField: field });

  it("refuses to ask for a field a third time", async () => {
    const d = admit(open, propose({ targetField: "timeline", message: "Your timeline?" }),
      ctx({ evidence: ev({ target_program: "online_mba" }),
            moves: [asked("timeline"), asked("timeline")] }));
    expect(d).toMatchObject({ overridden: true, rule: "ask_repeated", move: "ask" });
    expect(d.targetField).toBe("budget_band");
  });

  it("allows the one re-ask the journey permits", () => {
    const d = admit(open, propose({ targetField: "timeline", message: "Which intake — this, next?" }),
      ctx({ evidence: ev({ target_program: "online_mba" }), moves: [asked("timeline")] }));
    expect(d).toMatchObject({ overridden: false, move: "ask", targetField: "timeline" });
  });

  it("counts the whole conversation, so alternating fields cannot loop", () => {
    // stuck, other, stuck — consecutive counting would see a streak of one.
    const d = admit(open, propose({ targetField: "timeline", message: "Timeline?" }),
      ctx({ evidence: ev({ target_program: "online_mba" }),
            moves: [asked("timeline"), asked("budget_band"), asked("timeline")] }));
    expect(d.rule).toBe("ask_repeated");
  });

  it("hands to a human when the stuck field is all that is left", () => {
    const d = admit(open, propose({ targetField: "timeline", message: "Timeline?" }),
      ctx({
        evidence: ev({
          target_program: "online_mba", budget_band: "5L_to_15L",
          decision_maker: "self", prior_qualification: "B.Tech",
        }),
        moves: [asked("timeline"), asked("timeline")],
      }));
    expect(d).toMatchObject({ move: "escalate", rule: "ask_repeated" });
  });

  it("never closes with required evidence missing, even with nothing left to ask", () => {
    // Closing would record an inconclusive lead as if it had run its course.
    const d = admit(open, propose({ move: "close", message: "" }),
      ctx({
        evidence: ev({ target_program: "online_mba", budget_band: "5L_to_15L",
                       decision_maker: "self", prior_qualification: "B.Tech" }),
        moves: [asked("timeline"), asked("timeline")],
      }));
    expect(d.move).toBe("escalate");
  });

  it("forgets the limit once the field is established", () => {
    expect(exhaustedFields(open, [asked("timeline"), asked("timeline")],
      ev({ timeline: "next_intake" }))).toEqual(new Set());
  });

  it("honours the journey's own limit", () => {
    const patient = variant((s) => { s.strategy.max_asks_per_field = 3; });
    const d = admit(patient, propose({ targetField: "timeline", message: "Timeline?" }),
      ctx({ evidence: ev({ target_program: "online_mba" }),
            moves: [asked("timeline"), asked("timeline")] }));
    expect(d.overridden).toBe(false);
  });
});
