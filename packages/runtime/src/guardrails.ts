import {
  FIGURE, knowledgeEntry, moveAllowed, pinnedText,
  type JourneySpec,
} from "@midfunnel/core/journey/spec";
import type { Move, OverrideRule } from "@midfunnel/core/journey/moves";
import type { MoveRecord } from "@midfunnel/core/events/types";
import { established, evidenceComplete, nextField, type Evidence } from "./scoring.js";

/**
 * What the planner asked to do. Every field is untrusted: `move` may be a word
 * that is not a move at all, `targetField` a field the contract never declared.
 * Validating here rather than in the schema is deliberate — a structured-output
 * schema can constrain the shape but not the semantics, and a proposal rejected
 * by the API is a proposal nobody can count.
 */
export interface MoveProposal {
  move: string;
  /** One line, in the planner's own words. Recorded verbatim. */
  rationale: string;
  /**
   * What to say. For `answer` this is FRAMING ONLY — the fact itself comes from
   * the journey's knowledge block and is appended by the guardrail.
   */
  message: string;
  targetField: string | null;
  knowledgeKey: string | null;
  capability: string | null;
  confidence: number;
}

export interface GuardrailContext {
  evidence: Evidence;
  /** Planner decisions so far, folded from the log. Drives the deflection cap. */
  moves: readonly MoveRecord[];
  /** Whether the caller can actually perform a tool call this turn. */
  toolsAvailable: boolean;
}

/**
 * The decision, after policy.
 *
 * `message === null` means the runtime must write the text itself: the move was
 * changed, so whatever the planner wrote was for a different move and cannot be
 * reused. That costs a second model call on every override, which is the right
 * incentive — a journey whose guardrails fire constantly should feel expensive.
 */
export interface AdmittedMove {
  move: Move;
  message: string | null;
  rationale: string;
  /** What the planner asked for, preserved even when it was not allowed. */
  proposed: string;
  overridden: boolean;
  rule: OverrideRule | null;
  targetField: string | null;
  knowledgeKey: string | null;
  capability: string | null;
}

/**
 * Turns in a row the agent has spent not collecting anything.
 *
 * Counted from the end of the log, over performed moves rather than proposed
 * ones: a deflection the guardrail already blocked did not happen, and holding it
 * against the agent would punish it twice for one mistake.
 */
export function deflectionStreak(moves: readonly MoveRecord[]): number {
  let n = 0;
  for (let i = moves.length - 1; i >= 0; i--) {
    const m = moves[i]!.move;
    if (m === "acknowledge" || m === "answer") n++;
    else break;
  }
  return n;
}

/**
 * Fields the agent has asked for as often as the journey allows, and still does
 * not have.
 *
 * Counted over the whole conversation, not just the tail: counting only
 * consecutive asks lets an agent alternate — stuck field, another field, stuck
 * field again — and loop just as surely, one step removed.
 */
export function exhaustedFields(
  spec: JourneySpec, moves: readonly MoveRecord[], evidence: Evidence,
): Set<string> {
  const asked = new Map<string, number>();
  for (const m of moves) {
    if (m.move === "ask" && m.targetField) {
      asked.set(m.targetField, (asked.get(m.targetField) ?? 0) + 1);
    }
  }
  const out = new Set<string>();
  for (const [field, n] of asked) {
    if (n >= spec.strategy.max_asks_per_field && !established(evidence, field)) out.add(field);
  }
  return out;
}

/** What the agent says when it decided to answer something it has no fact for. */
const DEFAULT_DEFLECTION =
  "That's a good question and I don't want to guess at the answer — " +
  "I'll make sure someone covers it properly.";

/**
 * Admit the planner's move, or override it and say which rule did.
 *
 * Pure, and the only place a move becomes permitted. Every rejection names a
 * rule from a closed set, because "the guardrail blocked it" is not an answer
 * anyone can act on — and because a named rule can be counted, which is how you
 * find out that your journey and your agent disagree about the job.
 */
export function admit(
  spec: JourneySpec, proposal: MoveProposal, ctx: GuardrailContext,
): AdmittedMove {
  const deny = (rule: OverrideRule): AdmittedMove => fallback(spec, proposal, ctx, rule);
  const keep = (over: Partial<AdmittedMove> = {}): AdmittedMove => ({
    move: proposal.move as Move,
    message: proposal.message.trim(),
    rationale: proposal.rationale,
    proposed: proposal.move,
    overridden: false,
    rule: null,
    targetField: proposal.targetField,
    knowledgeKey: proposal.knowledgeKey,
    capability: proposal.capability,
    ...over,
  });

  if (!moveAllowed(spec, proposal.move)) return deny("move_not_permitted");

  const move = proposal.move as Move;
  const text = proposal.message.trim();

  switch (move) {
    // Handing to a human is never second-guessed. A guardrail that can override
    // an escalation is a guardrail that can trap someone in a bot.
    case "escalate":
      return keep({ message: text || null });

    case "close": {
      if (!evidenceComplete(spec, ctx.evidence) && !spec.strategy.allow_unscripted_close) {
        return deny("close_without_required_evidence");
      }
      // Closing sends nothing, exactly as the scripted path does: the turn
      // produces a score, a route and an end, not a farewell.
      return keep({ message: null });
    }

    case "answer": {
      const fact = proposal.knowledgeKey ? knowledgeEntry(spec, proposal.knowledgeKey) : undefined;
      if (!fact) return deny("answer_without_knowledge");

      // The framing is the model's; the fact is the tenant's, verbatim. A policy
      // that forbids quoting figures constrains the framing only — a journey may
      // certainly declare its own fee and expect the agent to state it.
      if (spec.policy.never.includes("quote_exact_fees") && FIGURE.test(text)) {
        return keep({ message: fact, overridden: true, rule: "answer_quoted_a_figure" });
      }
      return keep({ message: text ? `${text} ${fact}` : fact });
    }

    case "acknowledge": {
      if (deflectionStreak(ctx.moves) >= spec.strategy.max_deflections) {
        return deny("deflections_exhausted");
      }
      if (!text) return deny("empty_message");
      return keep();
    }

    case "offer": {
      const declared = spec.tools.some((t) => t.capability === proposal.capability);
      if (!proposal.capability || !declared) return deny("offer_without_binding");
      const granted = spec.agent.privileges.some((p) => p.split(":")[0] === proposal.capability);
      if (!granted) return deny("offer_without_privilege");
      // No caller to perform it: the same verdict the broker would reach, minus
      // a promise to the lead that nothing would have kept.
      if (!ctx.toolsAvailable) return deny("offer_without_binding");
      if (!text) return deny("empty_message");
      return keep();
    }

    case "ask": {
      const field = proposal.targetField;
      if (!field || !(field in spec.evidence)) return deny("ask_unknown_field");
      if (established(ctx.evidence, field)) return deny("ask_already_established");
      if (exhaustedFields(spec, ctx.moves, ctx.evidence).has(field)) return deny("ask_repeated");
      const nothingEstablished = Object.keys(ctx.evidence).length === 0;
      if (spec.evidence[field]!.sensitive && nothingEstablished) {
        return deny("ask_sensitive_too_early");
      }
      if (!text) return deny("empty_message");
      return keep();
    }
  }
}

/**
 * Where a rejected proposal lands.
 *
 * Order matters and encodes a judgement. A question the agent cannot answer gets
 * an honest deflection rather than a change of subject, because changing the
 * subject when someone asks you something is the exact failure this strategy
 * exists to fix. Everything else falls back to asking — and to the field the
 * SCRIPTED strategy would have chosen, so the two remain comparable at precisely
 * the moments the open one goes wrong.
 */
function fallback(
  spec: JourneySpec, proposal: MoveProposal, ctx: GuardrailContext, rule: OverrideRule,
): AdmittedMove {
  const base: {
    rationale: string; proposed: string; overridden: true;
    rule: OverrideRule; knowledgeKey: null; capability: null;
  } = {
    rationale: proposal.rationale,
    proposed: proposal.move,
    overridden: true,
    rule,
    knowledgeKey: null,
    capability: null,
  };

  const exhausted = deflectionStreak(ctx.moves) >= spec.strategy.max_deflections;

  if (rule === "answer_without_knowledge") {
    if (moveAllowed(spec, "acknowledge") && !exhausted) {
      return {
        ...base, move: "acknowledge", targetField: null,
        message: pinnedText(spec, "deflection") ?? DEFAULT_DEFLECTION,
      };
    }
    // The proposal failed for one reason and landed somewhere else for another.
    // Record the one that actually decided the outcome, or the log says the agent
    // changed the subject because it lacked a fact — when in truth it lacked a
    // fact AND had run out of turns to be gracious about it.
    if (exhausted) base.rule = "deflections_exhausted";
  }

  // Whatever the proposal was, the fallback never lands on a field the agent has
  // already asked for too often — or the guardrail would recreate the loop it
  // exists to break.
  const field = nextField(spec, ctx.evidence, exhaustedFields(spec, ctx.moves, ctx.evidence));
  if (field !== null && moveAllowed(spec, "ask")) {
    return { ...base, move: "ask", message: null, targetField: field };
  }
  // Nothing left the agent may ask for. That is a finished conversation only if
  // what is required is actually established; otherwise it is a conversation the
  // agent cannot finish, and closing it would record an inconclusive lead as if
  // it had run its course.
  const done = evidenceComplete(spec, ctx.evidence) || spec.strategy.allow_unscripted_close;
  if (done && moveAllowed(spec, "close")) {
    return { ...base, move: "close", message: null, targetField: null };
  }
  // A human can ask the question in a way that lands. A human always is admissible.
  return { ...base, move: "escalate", message: null, targetField: null };
}
