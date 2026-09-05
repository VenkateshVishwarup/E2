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
 * swappable behind its interface. It is far weaker than the model — it reads
 * declared enum values out of what the LEAD said and nothing else — which is
 * why the server logs loudly when it falls back to this.
 */
export class KeywordExtractor {
  async extract(spec: JourneySpec, turns: Turn[]): Promise<Record<string, ExtractedField>> {
    const out: Record<string, ExtractedField> = {};

    // Lead turns only: an option the AGENT named is not evidence.
    const leadText = turns.filter((t) => t.role === "lead").map((t) => normalise(t.text));

    for (const [field, def] of Object.entries(spec.evidence)) {
      const t = parseTypeExpr(def.type);
      if (t.kind !== "enum") continue;

      // Newest first, so a later statement supersedes an earlier one.
      for (let i = leadText.length - 1; i >= 0; i--) {
        const hit = bestMatch(leadText[i]!, t.values);
        if (hit) { out[field] = hit; break; }
      }
    }
    return out;
  }
}

/**
 * `executive_mba` has to match someone typing "the executive MBA". Comparing
 * the raw enum value against raw text never does, because the underscore is not
 * in the sentence — which made the offline agent look broken to anyone who
 * typed like a person rather than pasting an identifier.
 */
function normalise(text: string): string {
  return ` ${text.toLowerCase().replace(/[_\-/]+/g, " ").replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ").trim()} `;
}

interface Match extends ExtractedField { specificity: number }

function bestMatch(haystack: string, values: readonly string[]): Match | null {
  let best: Match | null = null;

  for (const value of values) {
    const phrase = normalise(value).trim();
    const words = phrase.split(" ").filter((w) => w.length > 0);

    // A contiguous phrase is unambiguous. Every word present but scattered is
    // probably right and reported at lower confidence, so a field with a high
    // `confidence_min` can still reject it.
    const contiguous = haystack.includes(` ${phrase} `) || haystack.includes(` ${phrase}`);
    const scattered = words.every((w) => haystack.includes(` ${w} `));
    if (!contiguous && !scattered) continue;

    // More words matched is a more specific claim: prefer `full time mba` over
    // a bare `mba` when both appear.
    const candidate: Match = {
      value,
      confidence: contiguous ? 0.95 : 0.8,
      specificity: words.length * (contiguous ? 2 : 1),
    };
    if (!best || candidate.specificity > best.specificity) best = candidate;
  }

  return best;
}
