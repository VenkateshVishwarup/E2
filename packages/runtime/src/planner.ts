import type OpenAI from "openai";
import * as z from "zod/v4";
import { zodTextFormat } from "openai/helpers/zod";
import {
  allowedMoves, knowledgeKeys, requiredEvidenceFields, type JourneySpec,
} from "@midfunnel/core/journey/spec";
import { MOVE_INTENT, type Move } from "@midfunnel/core/journey/moves";
import type { LeadState } from "@midfunnel/core/events/types";
import { cacheKey, MAX_TOKENS, modelFor } from "./provider.js";
import type { CostMeter } from "./meter.js";
import { exhaustedFields, type MoveProposal } from "./guardrails.js";
import {
  collectionComplete, established, evidenceComplete, nextField, type Evidence,
} from "./scoring.js";

/**
 * Chooses the next move.
 *
 * An interface rather than a class so the offline stand-in is a peer and not a
 * special case: the runtime cannot tell them apart, which is what keeps the
 * model-free demo honest about what the real thing does.
 */
export interface Planner {
  plan(spec: JourneySpec, state: LeadState, evidence: Evidence): Promise<MoveProposal>;
}

/**
 * The structured shape of a decision.
 *
 * Built per journey, because the valid values depend on the spec: `target_field`
 * is an enum over the declared evidence, `knowledge_key` over the declared facts,
 * `capability` over the declared tools. So the API rejects an invented field name
 * before the guardrail has to, and the guardrail's own checks become
 * defence-in-depth rather than the only line.
 */
function proposalSchema(spec: JourneySpec) {
  const fields = Object.keys(spec.evidence);
  const knowledge = knowledgeKeys(spec);
  const capabilities = spec.tools.map((t) => t.capability);
  // z.enum needs at least one member; an empty list becomes a plain nullable
  // string, which the guardrail then rejects by name.
  const oneOf = (values: string[]) =>
    values.length > 0
      ? z.enum(values as [string, ...string[]]).nullable()
      : z.string().nullable();

  return z.object({
    move: z.enum(allowedMoves(spec) as [Move, ...Move[]]),
    rationale: z.string().describe("One short sentence: why this move, now."),
    message: z.string().describe(
      "What to say. Empty for close. For answer, the FRAMING ONLY — one short " +
      "sentence that is not itself the fact; the fact is appended for you.",
    ),
    target_field: oneOf(fields).describe("Only for ask. Null otherwise."),
    knowledge_key: oneOf(knowledge).describe("Only for answer. Null otherwise."),
    capability: oneOf(capabilities).describe("Only for offer. Null otherwise."),
    confidence: z.number().min(0).max(1),
  });
}

export class ModelPlanner implements Planner {
  constructor(private readonly client: OpenAI, private readonly meter?: CostMeter) {}

  async plan(spec: JourneySpec, state: LeadState, evidence: Evidence): Promise<MoveProposal> {
    const model = modelFor("runtime");
    const response = await this.client.responses.parse({
      model,
      max_output_tokens: MAX_TOKENS,
      reasoning: { effort: spec.strategy.reasoning_effort },
      // Stable prefix first, volatile last, byte-identical across every
      // conversation in a journey version — the discipline that makes the
      // platform's automatic prefix caching hit at all.
      instructions: plannerPrompt(spec),
      prompt_cache_key: cacheKey(spec.journey, spec.version),
      text: { format: zodTextFormat(proposalSchema(spec), "move") },
      input: situation(spec, state, evidence),
    });

    this.meter?.record(model, response.usage);

    const parsed = response.output_parsed as {
      move: string; rationale: string; message: string;
      target_field: string | null; knowledge_key: string | null;
      capability: string | null; confidence: number;
    } | null;
    if (!parsed) throw new Error("planner received no structured output from the model");

    return {
      move: parsed.move,
      rationale: parsed.rationale,
      message: parsed.message,
      targetField: parsed.target_field,
      knowledgeKey: parsed.knowledge_key,
      capability: parsed.capability,
      confidence: parsed.confidence,
    };
  }
}

/**
 * A model-free planner, so the open strategy is demonstrable with no credential.
 *
 * It is not a simulation of good judgement — it is the smallest rule set that
 * produces the behaviour the strategy exists for: a lead who asks a question
 * gets an answer attempt rather than the next slot. When nothing in `knowledge`
 * covers the question it proposes `answer` with no key on purpose, so the
 * guardrail converts it into an honest deflection. That path is the one worth
 * seeing offline, because it is the one a real planner reaches most often.
 */
export class OfflinePlanner implements Planner {
  async plan(spec: JourneySpec, state: LeadState, evidence: Evidence): Promise<MoveProposal> {
    const lastLead = [...state.turns].reverse().find((t) => t.role === "lead");
    const text = lastLead?.text ?? "";
    const base = { capability: null, confidence: 0.6 };

    if (/\?/.test(text)) {
      const key = bestKnowledgeMatch(spec, text);
      return {
        ...base, move: "answer",
        rationale: key
          ? `the lead asked something the "${key}" entry covers`
          : "the lead asked a question no declared knowledge entry covers",
        message: key ? "Happy to explain." : "",
        targetField: null, knowledgeKey: key,
      };
    }

    // Skip what has already been asked for as often as allowed. Proposing it
    // anyway would only be overridden; the guardrail stays the backstop.
    const spent = exhaustedFields(spec, state.moves, evidence);
    const field = nextField(spec, evidence, spent);
    if (field !== null && !collectionComplete(spec, evidence, spent)) {
      const again = state.moves.some((m) => m.move === "ask" && m.targetField === field);
      return {
        ...base, move: "ask",
        rationale: again
          ? `the last answer did not establish ${field}, so asking once more, differently`
          : `${field} is still missing and is needed to qualify`,
        message: again ? reaskOffline(spec, field) : askOffline(spec, field),
        targetField: field, knowledgeKey: null,
      };
    }

    return {
      ...base, move: "close",
      rationale: "everything required has been established",
      message: "", targetField: null, knowledgeKey: null,
    };
  }
}

/**
 * Crude weighted word overlap. Enough to pick the right entry when one clearly
 * applies, and to pick none when the question is about parking.
 *
 * A word from the KEY counts double: "scholarships" naming the `scholarships`
 * entry is a topic match on its own, whereas one word shared with a fact's prose
 * is a coincidence. Below the threshold the planner deliberately proposes an
 * answer with no key, so the guardrail turns it into an honest deflection — a
 * wrong fact is far worse than an admitted gap.
 */
function bestKnowledgeMatch(spec: JourneySpec, question: string): string | null {
  const asked = new Set(words(question));
  let best: { key: string; weight: number } | null = null;

  for (const [key, fact] of Object.entries(spec.knowledge)) {
    const keyTerms = new Set(words(key));
    const factTerms = new Set(words(fact));
    let weight = 0;
    for (const w of asked) {
      if (keyTerms.has(w)) weight += 2;
      else if (factTerms.has(w)) weight += 1;
    }
    if (weight > 0 && (best === null || weight > best.weight)) best = { key, weight };
  }
  return best && best.weight >= 2 ? best.key : null;
}

const STOP = new Set([
  "the", "a", "an", "is", "are", "do", "does", "did", "what", "how", "much",
  "can", "i", "you", "we", "my", "me", "to", "for", "of", "and", "or", "in",
  "on", "it", "that", "this", "there", "any", "be", "will", "would", "about",
]);

function words(s: string): string[] {
  return s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2 && !STOP.has(w));
}

/**
 * The second ask for a field. Repeating the first word for word is what made
 * the agent read as stuck on an exact phrase; a re-ask should lower the bar
 * ("roughly", "closest") rather than restate it.
 */
function reaskOffline(spec: JourneySpec, field: string): string {
  const def = spec.evidence[field]!;
  const m = /^enum\[(.+)\]$/.exec(def.type.trim());
  const options = m ? m[1]!.split(",").map((v) => v.trim().replace(/_/g, " ")) : [];
  if (options.length === 0) {
    return `No problem — even a rough answer on your ${field.replace(/_/g, " ")} helps.`;
  }
  const list = options.length > 1
    ? `${options.slice(0, -1).join(", ")} or ${options.at(-1)}`
    : options[0];
  return `No problem — just roughly, which is closest: ${list}?`;
}

/** The offline question writer, with the declared options named. */
function askOffline(spec: JourneySpec, field: string): string {
  const def = spec.evidence[field]!;
  const m = /^enum\[(.+)\]$/.exec(def.type.trim());
  const options = m ? m[1]!.split(",").map((v) => v.trim().replace(/_/g, " ")) : [];
  const q = def.description ? `${def.description}?` : `Could you tell me your ${field.replace(/_/g, " ")}?`;
  return options.length > 0 ? `${q} (${options.join(", ")})` : q;
}

/**
 * The stable half of the prompt: everything derived from the spec, in a fixed
 * order, with nothing about this conversation in it.
 */
function plannerPrompt(spec: JourneySpec): string {
  const moves = allowedMoves(spec);
  const knowledge = Object.entries(spec.knowledge);

  return [
    `You are ${spec.agent.persona}, talking to a ${spec.vertical} lead over chat.`,
    `Goal: ${spec.objective.goal}.`,
    "",
    "Each turn you choose ONE move. You are not filling in a form: the lead may " +
    "say anything, in any order, and may ask you things. Deal with what they " +
    "actually said before returning to what you need.",
    "",
    "MOVES",
    ...moves.map((m) => `- ${m}: ${MOVE_INTENT[m]}`),
    "",
    "EVIDENCE you are trying to establish",
    ...Object.entries(spec.evidence).map(([f, d]) =>
      `- ${f} (${d.type})${d.required ? " [required]" : ""}` +
      `${d.sensitive ? " [sensitive — never the first thing you ask]" : ""}` +
      `${d.description ? `: ${d.description}` : ""}`),
    "",
    "FACTS you may state — and nothing else",
    ...(knowledge.length > 0
      ? knowledge.map(([k, v]) => `- ${k}: ${v}`)
      : ["- (none declared; you cannot assert any fact)"]),
    "",
    ...(spec.tools.length > 0
      ? ["TOOLS you may offer to use",
         ...spec.tools.map((t) => `- ${t.capability}`), ""]
      : []),
    "RULES",
    ...spec.policy.never.map((r) => `- never ${r}`),
    "- Choose `answer` only when a FACT above covers the question. If none does, " +
    "choose `acknowledge` and say you will get them a proper answer. Never improvise a fact.",
    "- For `answer`, `message` is your framing only. The fact is appended verbatim; " +
    "do not restate it and do not put a figure in your framing.",
    "- One short message, under 35 words. No preamble, no sign-off, no emoji.",
    `- You may spend at most ${spec.strategy.max_deflections} turn(s) in a row not collecting anything.`,
    `- Ask for any one field at most ${spec.strategy.max_asks_per_field} time(s). If the lead's ` +
    "answer did not land, rephrase once with the options; after that move on, or escalate " +
    "if nothing else is missing. Never repeat a question word for word.",
    ...(spec.strategy.allow_unscripted_close
      ? []
      : [spec.objective.collect === "all"
          ? "- This journey collects EVERY declared field before scoring, optional ones " +
            "included: each carries score, and a lead scored on the required fields alone " +
            "can be routed lower than they deserve. Do not choose `close` while any field " +
            "is still missing."
          : "- Do not choose `close` while any required evidence is missing."]),
  ].join("\n");
}

/** The volatile half: this conversation, right now. */
function situation(spec: JourneySpec, state: LeadState, evidence: Evidence): string {
  const required = requiredEvidenceFields(spec);
  return JSON.stringify({
    transcript: state.turns.map((t) =>
      `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`).join("\n"),
    established: Object.fromEntries(
      Object.entries(evidence).map(([k, v]) => [k, v.value]),
    ),
    still_missing_required: required.filter((f) => !established(evidence, f)),
    still_missing_optional: Object.keys(spec.evidence)
      .filter((f) => !required.includes(f) && !established(evidence, f)),
    collect: spec.objective.collect,
    // Asked for as often as the journey allows without it landing. Do not ask
    // again — move on, or hand to a human if nothing else is missing.
    do_not_ask_again: [...exhaustedFields(spec, state.moves, evidence)],
    required_complete: evidenceComplete(spec, evidence),
    recent_moves: state.moves.slice(-4).map((m) =>
      m.overridden ? `${m.proposed} -> ${m.move} (${m.rule})` : m.move),
    turns_used: state.turns.length,
    turn_budget: spec.policy.max_turns,
  }, null, 2);
}
