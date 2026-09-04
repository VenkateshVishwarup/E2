import type OpenAI from "openai";
import { zodTextFormat } from "openai/helpers/zod";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { evidenceToZod } from "./evidence-schema.js";
import { cacheKey, createClient, MAX_TOKENS, modelFor } from "./provider.js";

export interface ExtractedField { value: unknown; confidence: number }

export class EvidenceExtractor {
  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? createClient();
  }

  /**
   * Returns only fields that are established: non-null, and at or above the
   * field's declared `confidence_min`. Everything else is simply absent — the
   * runtime treats absence as "still to be collected".
   */
  async extract(spec: JourneySpec, turns: Turn[]): Promise<Record<string, ExtractedField>> {
    const schema = evidenceToZod(spec);

    const transcript = turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "LEAD"}: ${t.text}`)
      .join("\n");

    const response = await this.client.responses.parse({
      model: modelFor("extractor"),
      max_output_tokens: MAX_TOKENS,
      // Schema-constrained work: the schema does the heavy lifting, so low
      // effort is sufficient and this runs on every turn of every conversation.
      reasoning: { effort: "low" },
      // Stable prefix first, volatile input last — this is what makes the
      // platform's automatic prefix caching actually hit.
      instructions: systemPrompt(spec),
      prompt_cache_key: cacheKey(spec.journey, spec.version),
      text: { format: zodTextFormat(schema, "evidence") },
      input: `TRANSCRIPT\n\n${transcript}`,
    });

    const parsed = response.output_parsed as Record<string, ExtractedField> | null;
    if (!parsed) throw new Error("extractor received no structured output from the model");

    const out: Record<string, ExtractedField> = {};
    for (const [field, def] of Object.entries(spec.evidence)) {
      const got = parsed[field];
      if (!got || got.value === null || got.value === undefined) continue;
      if (got.confidence < def.confidence_min) continue;
      out[field] = { value: got.value, confidence: got.confidence };
    }
    return out;
  }
}

function systemPrompt(spec: JourneySpec): string {
  const fields = Object.entries(spec.evidence)
    .map(([f, d]) => `- ${f} (${d.type})${d.required ? " [required]" : ""}: ${d.description ?? ""}`)
    .join("\n");

  return [
    `You extract structured evidence from a ${spec.vertical} lead-qualification conversation.`,
    `Journey: ${spec.journey} v${spec.version}. Goal: ${spec.objective.goal}.`,
    "",
    "Fields to establish:",
    fields,
    "",
    "Rules:",
    "- Report only what the LEAD actually said or clearly implied. Never infer from the agent's questions.",
    "- If a field was not established, set value to null and confidence to 0.",
    "- confidence is your calibrated probability that the value is correct.",
  ].join("\n");
}
