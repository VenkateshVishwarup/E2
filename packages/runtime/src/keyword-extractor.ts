import type { JourneySpec } from "@midfunnel/core/journey/spec";
import { parseTypeExpr } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import type { ExtractedField } from "./extractor.js";

/**
 * A deterministic, no-model extractor honouring the same `extract()` contract
 * as EvidenceExtractor.
 *
 * It exists for three reasons: local development and demos without an API key,
 * fully reproducible replay numbers, and as proof that extraction is genuinely
 * swappable behind its interface. It only matches declared enum values spoken
 * by the LEAD, so it is far weaker than the model — that is the point, and it
 * is why the server logs loudly when it falls back to this.
 */
export class KeywordExtractor {
  async extract(spec: JourneySpec, turns: Turn[]): Promise<Record<string, ExtractedField>> {
    const out: Record<string, ExtractedField> = {};

    // Lead turns only: an option the AGENT named is not evidence.
    const leadText = turns.filter((t) => t.role === "lead").map((t) => t.text);

    for (const [field, def] of Object.entries(spec.evidence)) {
      const t = parseTypeExpr(def.type);
      if (t.kind !== "enum") continue;

      // Scan newest first so a later statement supersedes an earlier one.
      for (let i = leadText.length - 1; i >= 0; i--) {
        const haystack = leadText[i]!.toLowerCase();
        const hit = t.values.find((v) => haystack.includes(v.toLowerCase()));
        if (hit) {
          out[field] = { value: hit, confidence: 0.95 };
          break;
        }
      }
    }
    return out;
  }
}
