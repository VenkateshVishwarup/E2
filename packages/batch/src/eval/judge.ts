import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import * as z from "zod/v4";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { cacheKey, createClient, MAX_TOKENS, MODEL } from "@midfunnel/runtime/provider";
import { undetectableRules, type Scorecard } from "./scorecard.js";

export interface Judgement {
  naturalness: number;
  questionQuality: number;
  policyBreaches: string[];
  notes: string;
}

export interface JudgedScorecard extends Scorecard {
  judgement: Judgement | null;
}

const judgementSchema = z.object({
  naturalness: z.number().min(1).max(5)
    .describe("Does this read like a competent human counsellor, not a form?"),
  questionQuality: z.number().min(1).max(5)
    .describe("Were the questions well-chosen, well-ordered, and never repeated?"),
  policyBreaches: z.array(z.string())
    .describe("Rule ids from the supplied list that the AGENT actually breached."),
  notes: z.string().max(400).describe("One or two sentences on the weakest moment."),
});

export class ConversationJudge {
  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? createClient();
  }

  /**
   * Scores what a regex cannot. The deterministic checks have already settled
   * completeness, correctness and the pattern-matchable policy rules; asking
   * the model to redo those would add cost and variance to facts already known
   * exactly.
   */
  async judge(spec: JourneySpec, state: LeadState, card: Scorecard): Promise<Judgement> {
    const openRules = undetectableRules(spec);
    const transcript = state.turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`)
      .join("\n");

    const response = await this.client.responses.parse({
      model: MODEL,
      max_output_tokens: MAX_TOKENS,
      // The judge must never be weaker than the judged.
      reasoning: { effort: "high" },
      text: { format: zodTextFormat(judgementSchema, "judgement") },
      prompt_cache_key: `judge:${cacheKey(spec.journey, spec.version)}`,
      instructions: [
        `You review lead-qualification conversations for a ${spec.vertical} institution.`,
        `The agent's goal was: ${spec.objective.goal}.`,
        "",
        "Judge only these policy rules — the others are already checked mechanically:",
        ...(openRules.length ? openRules.map((r) => `- ${r}`) : ["- (none)"]),
        "",
        "Score naturalness and questionQuality 1-5. Be exacting: 5 means you would be",
        "happy for this to represent the institution to a paying customer.",
        "Judge only the AGENT's conduct. Never penalise the agent for what the lead said.",
      ].join("\n"),
      input: JSON.stringify({
        transcript,
        mechanical_findings: {
          evidenceCompleteness: card.evidenceCompleteness,
          evidenceCorrectness: card.evidenceCorrectness,
          hallucinatedFields: card.hallucinatedFields,
          turnsUsed: card.turnsUsed,
          outcome: card.outcome,
        },
      }, null, 2),
    });

    const parsed = response.output_parsed as Judgement | null;
    if (!parsed) throw new Error("judge received no structured output from the model");
    return parsed;
  }
}

export function attachJudgement(card: Scorecard, judgement: Judgement | null): JudgedScorecard {
  return { ...card, judgement };
}
