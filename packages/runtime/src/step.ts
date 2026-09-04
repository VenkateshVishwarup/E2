import type OpenAI from "openai";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { EvidenceExtractor, type ExtractedField } from "./extractor.js";
import { cacheKey, createClient, MAX_TOKENS, MODEL } from "./provider.js";
import { evaluatePredicate, evidenceComplete, qualifies, route, score, type Evidence } from "./scoring.js";
import { LexiconSentiment } from "./sentiment.js";

export type Action =
  | { kind: "send"; text: string; pinnedTemplate?: string }
  | { kind: "extract"; evidence: Record<string, ExtractedField> }
  | { kind: "score"; score: number }
  | { kind: "route"; decision: string; target: string; sla?: string }
  | { kind: "escalate"; reason: string }
  | { kind: "complete"; qualified: boolean };

export interface StepOptions {
  /**
   * Whether the runtime may generate a follow-up question. True for live
   * conversation; false for replay, where the transcript is already complete.
   */
  allowFollowUp?: boolean;
}

const HUMAN_REQUEST = /\b(human|agent|person|representative|talk to someone|real person)\b/i;

export class AgentRuntime {
  private readonly extractor: EvidenceExtractor;
  private readonly client: OpenAI;
  private readonly sentiment = new LexiconSentiment();

  constructor(extractor?: EvidenceExtractor, client?: OpenAI) {
    this.client = client ?? createClient();
    this.extractor = extractor ?? new EvidenceExtractor(this.client);
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
      const disclosure = spec.pinned.disclosure ?? "";
      return [{
        kind: "send",
        text: disclosure || "Hello.",
        ...(spec.pinned.opening ? { pinnedTemplate: spec.pinned.opening } : {}),
      }];
    }

    const actions: Action[] = [];

    // 2. Explicit human request short-circuits everything.
    const lastLead = [...state.turns].reverse().find((t) => t.role === "lead");
    if (lastLead && HUMAN_REQUEST.test(lastLead.text)) {
      return [{ kind: "escalate", reason: "asks_for_human" }];
    }

    // 3. Extract, then merge over what is already known.
    const fresh = await this.extractor.extract(spec, state.turns);
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
    const leadTurns = state.turns.filter((t) => t.role === "lead").length;
    if (state.turns.length >= spec.policy.max_turns || leadTurns >= spec.policy.max_turns) {
      actions.push({ kind: "complete", qualified: false });
      return actions;
    }

    // 6. Required evidence complete — score, route, finish.
    if (evidenceComplete(spec, evidence)) {
      const s = score(spec, evidence);
      const r = route(spec, s);
      actions.push({ kind: "score", score: s });
      actions.push({ kind: "route", ...r });
      actions.push({ kind: "complete", qualified: qualifies(spec, s, evidence) });
      return actions;
    }

    // 7. Otherwise ask for the next missing field — unless follow-up is off.
    //    Replay runs against a finished transcript: there is no lead left to
    //    answer, so asking would burn a model call and produce nothing.
    if (!allowFollowUp) {
      actions.push({ kind: "complete", qualified: false });
      return actions;
    }
    const target = nextField(spec, evidence);
    actions.push({ kind: "send", text: await this.ask(spec, state, evidence, target) });
    return actions;
  }

  private async ask(
    spec: JourneySpec, state: LeadState, evidence: Evidence, field: string,
  ): Promise<string> {
    const def = spec.evidence[field]!;
    const transcript = state.turns.map((t) =>
      `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`).join("\n");

    const response = await this.client.responses.create({
      model: MODEL,
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

    const text = response.output_text.trim();
    if (!text) throw new Error("runtime received no text content from the model");
    return text;
  }
}

/**
 * Ordering rule: required before optional, and a `sensitive` field is never
 * asked while nothing at all is established — you do not open with money.
 */
function nextField(spec: JourneySpec, evidence: Evidence): string {
  const missing = Object.entries(spec.evidence).filter(([f]) => {
    const got = evidence[f];
    return got === undefined || got.value === null || got.value === undefined;
  });
  const nothingEstablished = Object.keys(evidence).length === 0;

  const eligible = missing.filter(([, d]) => !(d.sensitive && nothingEstablished));
  const pool = eligible.length > 0 ? eligible : missing;

  const required = pool.find(([, d]) => d.required);
  return (required ?? pool[0]!)[0];
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
