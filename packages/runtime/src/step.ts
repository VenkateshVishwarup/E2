import type OpenAI from "openai";
import { isOpen, pinnedText, type JourneySpec } from "@midfunnel/core/journey/spec";
import type { Move } from "@midfunnel/core/journey/moves";
import type { LeadState } from "@midfunnel/core/events/types";
import { EvidenceExtractor, type ExtractedField } from "./extractor.js";
import { cacheKey, createClient, MAX_TOKENS, modelFor } from "./provider.js";
import { CostMeter } from "./meter.js";
import {
  evaluatePredicate, evidenceComplete, nextField, qualifies, route, score,
  type Evidence,
} from "./scoring.js";
import { admit, type AdmittedMove } from "./guardrails.js";
import { ModelPlanner, type Planner } from "./planner.js";
import { LexiconSentiment } from "./sentiment.js";

export type Action =
  | { kind: "send"; text: string; pinnedTemplate?: string }
  | { kind: "extract"; evidence: Record<string, ExtractedField> }
  | { kind: "score"; score: number }
  | { kind: "route"; decision: string; target: string; sla?: string }
  | { kind: "escalate"; reason: string }
  | { kind: "complete"; qualified: boolean }
  /**
   * An open-strategy decision: what the planner wanted, what it was allowed, and
   * which rule made the difference. Emitted before the actions that carry it out,
   * so the log reads in the order the turn actually happened.
   */
  | {
      kind: "move";
      move: Move;
      proposed: string;
      overridden: boolean;
      rule: string | null;
      rationale: string;
      confidence: number;
      targetField: string | null;
      knowledgeKey: string | null;
    }
  /**
   * A tool the agent chose to use. Carried out by the CALLER through the broker,
   * not here: the broker is the single egress point and writes its own events, so
   * performing it inside `step()` would put two authorities on one decision.
   */
  | { kind: "invoke"; capability: string; args: Record<string, unknown> };

export interface StepOptions {
  /**
   * Whether the runtime may generate a follow-up question. True for live
   * conversation; false for replay, where the transcript is already complete.
   */
  allowFollowUp?: boolean;
  /**
   * Trust the evidence already on the state instead of extracting again.
   *
   * Replay uses this to run both arms against ONE extraction of the same
   * transcript. That halves the model calls, but the reason to do it is
   * correctness rather than cost: extracting separately per arm injects model
   * variance into a comparison whose entire purpose is to isolate the change
   * between two journey versions. Only valid when both specs declare the same
   * evidence contract — the caller checks that.
   */
  reuseEvidence?: boolean;
  /**
   * Whether the caller will actually perform an `invoke` action. False by
   * default, so a caller that cannot reach the broker never lets the agent
   * promise a lead something that will not happen.
   */
  toolsAvailable?: boolean;
}

const HUMAN_REQUEST = /\b(human|agent|person|representative|talk to someone|real person)\b/i;

export class AgentRuntime {
  private readonly extractor: EvidenceExtractor;
  private readonly client: OpenAI;
  private readonly planner: Planner;
  private readonly sentiment = new LexiconSentiment();
  /** Token spend for the conversation currently being stepped. */
  readonly meter = new CostMeter();

  constructor(extractor?: EvidenceExtractor, client?: OpenAI, planner?: Planner) {
    this.client = client ?? createClient();
    this.extractor = extractor ?? new EvidenceExtractor(this.client, this.meter);
    this.planner = planner ?? new ModelPlanner(this.client, this.meter);
  }

  /** Extraction on its own, for callers that need it once and reuse it. */
  async extract(spec: JourneySpec, turns: LeadState["turns"]) {
    return this.extractor.extract(spec, turns);
  }

  /**
   * The whole contract. Pure with respect to the event log: it reads a folded
   * LeadState and returns intended actions. The caller persists them, which is
   * what lets replay, simulation and live traffic share one runtime.
   */
  async step(spec: JourneySpec, state: LeadState, opts: StepOptions = {}): Promise<Action[]> {
    const allowFollowUp = opts.allowFollowUp ?? true;
    // 1. First contact — deterministic, pinned, and never a model call.
    if (state.turns.length === 0) {
      // Still a template here. The caller renders it, because the values are
      // per-conversation and the runtime does not know the lead.
      const disclosure = pinnedText(spec, "disclosure") ?? "";
      const opening = pinnedText(spec, "opening");
      return [{
        kind: "send",
        text: disclosure || "Hello.",
        ...(opening ? { pinnedTemplate: opening } : {}),
      }];
    }

    const actions: Action[] = [];

    // ── Steps 2 to 5 are NOT the model's to decide, in either strategy. ──
    // Disclosure, an explicit request for a human, declared escalation policy
    // and the turn budget are commitments the tenant made to the lead and to
    // whoever pays for the tokens. An open agent gets to choose what to say; it
    // does not get to choose whether those hold.

    // 2. Explicit human request short-circuits everything.
    const lastLead = [...state.turns].reverse().find((t) => t.role === "lead");
    if (lastLead && HUMAN_REQUEST.test(lastLead.text)) {
      return [{ kind: "escalate", reason: "asks_for_human" }];
    }

    // 3. Extract, then merge over what is already known.
    const fresh = opts.reuseEvidence
      ? {}
      : await this.extractor.extract(spec, state.turns);
    if (Object.keys(fresh).length > 0) actions.push({ kind: "extract", evidence: fresh });
    const evidence: Evidence = { ...state.evidence, ...fresh };

    // 4. Declared escalation triggers on evidence and sentiment.
    const mood = this.sentiment.analyze(state.turns);
    const trigger = escalationTrigger(spec, evidence, mood.score);
    if (trigger) {
      actions.push({ kind: "escalate", reason: trigger });
      return actions;
    }

    // 5. Turn budget exhausted.
    //
    // Settle on whatever was established rather than dropping the lead. A
    // conversation that gave you everything and then ran past its budget is a
    // qualified lead, and discarding it because of a turn count is throwing away
    // the thing the journey exists to produce. `settle` refuses to invent a
    // decision when required evidence is missing, so an inconclusive conversation
    // still ends inconclusively.
    const leadTurns = state.turns.filter((t) => t.role === "lead").length;
    if (state.turns.length >= spec.policy.max_turns || leadTurns >= spec.policy.max_turns) {
      return [...actions, ...this.settle(spec, evidence, { requireComplete: true })];
    }

    // 6. From here the strategies part company.
    if (isOpen(spec)) {
      if (!allowFollowUp) {
        // Replay against a finished transcript: there is no lead left to react
        // to, so planning a reply would burn a call and change nothing. The
        // comparison that matters — did this version qualify this lead — still
        // runs, on the evidence the transcript contains.
        return [...actions, ...this.settle(spec, evidence, { requireComplete: true })];
      }
      return [...actions, ...await this.stepOpen(spec, state, evidence, opts)];
    }

    // 7. Scripted: required evidence complete — score, route, finish.
    if (evidenceComplete(spec, evidence)) {
      return [...actions, ...this.settle(spec, evidence, { requireComplete: false })];
    }

    // 8. Otherwise ask for the next missing field — unless follow-up is off.
    //    Replay runs against a finished transcript: there is no lead left to
    //    answer, so asking would burn a model call and produce nothing.
    if (!allowFollowUp) {
      actions.push({ kind: "complete", qualified: false });
      return actions;
    }
    const target = nextField(spec, evidence);
    if (target === null) return [...actions, ...this.settle(spec, evidence, { requireComplete: false })];
    actions.push({ kind: "send", text: await this.ask(spec, state, evidence, target) });
    return actions;
  }

  /**
   * One planner decision, admitted or overridden, then carried out.
   *
   * The two halves are deliberately separate calls: `plan` is the model's and may
   * return anything, `admit` is code and decides what actually happens. Nothing
   * between them can be skipped, because this is the only path into an action.
   */
  private async stepOpen(
    spec: JourneySpec, state: LeadState, evidence: Evidence, opts: StepOptions,
  ): Promise<Action[]> {
    const proposal = await this.planner.plan(spec, state, evidence);
    const decision = admit(spec, proposal, {
      evidence,
      moves: state.moves,
      toolsAvailable: opts.toolsAvailable ?? false,
    });

    const record: Action = {
      kind: "move",
      move: decision.move,
      proposed: decision.proposed,
      overridden: decision.overridden,
      rule: decision.rule,
      rationale: decision.rationale,
      confidence: proposal.confidence,
      targetField: decision.targetField,
      knowledgeKey: decision.knowledgeKey,
    };

    return [record, ...await this.perform(spec, state, evidence, decision)];
  }

  /** What each admitted move actually does. */
  private async perform(
    spec: JourneySpec, state: LeadState, evidence: Evidence, d: AdmittedMove,
  ): Promise<Action[]> {
    switch (d.move) {
      case "escalate":
        // A named reason rather than the rationale, so escalations stay
        // countable. The planner's own words are on the MoveChosen event.
        //
        // When the guardrail forced the handover, its rule is the reason; the
        // agent did not judge anything.
        return [{ kind: "escalate", reason: d.overridden && d.rule ? d.rule : "agent_judgement" }];

      case "close":
        return this.settle(spec, evidence, { requireComplete: false });

      case "ask": {
        // `message === null` means the move was overridden, so whatever the
        // planner wrote was for a different move and cannot be reused.
        const field = d.targetField ?? nextField(spec, evidence);
        if (field === null) return this.settle(spec, evidence, { requireComplete: false });
        const text = d.message ?? await this.ask(spec, state, evidence, field);
        return [{ kind: "send", text }];
      }

      case "answer":
      case "acknowledge":
        return [{ kind: "send", text: d.message ?? "" }];

      case "offer": {
        const args = Object.fromEntries(
          Object.entries(evidence).map(([k, v]) => [k, v.value]),
        );
        return [
          { kind: "send", text: d.message ?? "" },
          { kind: "invoke", capability: d.capability!, args },
        ];
      }
    }
  }

  /**
   * Score, route, finish. The one path by which a conversation ends with a
   * decision, shared by both strategies so an open journey cannot be scored on
   * different terms from a scripted one.
   */
  private settle(
    spec: JourneySpec, evidence: Evidence, opts: { requireComplete: boolean },
  ): Action[] {
    if (opts.requireComplete && !evidenceComplete(spec, evidence)) {
      return [{ kind: "complete", qualified: false }];
    }
    const s = score(spec, evidence);
    const r = route(spec, s, evidence);
    return [
      { kind: "score", score: s },
      { kind: "route", ...r },
      { kind: "complete", qualified: qualifies(spec, s, evidence) },
    ];
  }

  private async ask(
    spec: JourneySpec, state: LeadState, evidence: Evidence, field: string,
  ): Promise<string> {
    const def = spec.evidence[field]!;
    const transcript = state.turns.map((t) =>
      `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`).join("\n");

    const model = modelFor("runtime");
    const response = await this.client.responses.create({
      model,
      max_output_tokens: MAX_TOKENS,
      reasoning: { effort: "high" },
      instructions: [
        `You are ${spec.agent.persona}, qualifying a ${spec.vertical} lead over chat.`,
        `Goal: ${spec.objective.goal}.`,
        "",
        "You must NEVER:",
        ...spec.policy.never.map((r) => `- ${r}`),
        "",
        "Write ONE short, natural message. No preamble, no sign-off, no emoji.",
        "Under 30 words. Ask about exactly one thing.",
      ].join("\n"),
      prompt_cache_key: cacheKey(spec.journey, spec.version),
      input: JSON.stringify({
        transcript,
        established: Object.fromEntries(
          Object.entries(evidence).map(([k, v]) => [k, v.value]),
        ),
        ask_about: { field, type: def.type, description: def.description ?? null },
      }, null, 2),
    });

    this.meter.record(model, response.usage);

    const text = response.output_text.trim();
    if (!text) throw new Error("runtime received no text content from the model");
    return text;
  }
}

function escalationTrigger(
  spec: JourneySpec, evidence: Evidence, sentiment: number,
): string | null {
  for (const raw of spec.policy.escalate_when) {
    const rule = raw.trim();

    const ev = /^evidence\.(\w+)\s*==\s*(\S+)$/.exec(rule);
    if (ev) {
      const got = evidence[ev[1]!];
      if (got && String(got.value) === ev[2]) return rule;
      continue;
    }

    if (/^sentiment\s*(>=|<=|>|<|==)/.test(rule)) {
      if (evaluatePredicate(rule, { score: 0, evidenceComplete: false, sentiment })) {
        return rule;
      }
      continue;
    }
    // Rules with no evaluator are skipped, not thrown on: an unimplementable
    // policy rule must not break the runtime.
  }
  return null;
}
