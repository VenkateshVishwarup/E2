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
      if (t.kind === "string") {
        const answer = replyTo(turns, field);
        if (answer !== null) {
          out[field] = {
            value: def.maxLength ? answer.slice(0, def.maxLength) : answer,
            confidence: 0.75,
          };
        }
        continue;
      }
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

/**
 * Words too common to identify an option on their own, even when only one
 * option contains them. "this" names `this_intake` and also appears in half of
 * all sentences; "under" names `under_5L` and also "under pressure".
 */
const NOT_DISTINCTIVE = new Set([
  "this", "to", "time", "just", "needs", "under", "above", "the", "a", "and", "or",
]);

/**
 * A word that belongs to exactly one of a field's options — "next" among
 * this / next / just-exploring intakes.
 *
 * People answer a menu with the part that differs. Requiring every word of
 * `next_intake` meant "next" and "next mostly" matched nothing, and the agent
 * asked the same question until the turn budget ran out — which reads as an
 * agent that only accepts an exact phrase, because that is what it was.
 */
function distinctiveWords(
  values: readonly string[], { includeCommon = false } = {},
): Map<string, string> {
  const owners = new Map<string, Set<string>>();
  for (const value of values) {
    for (const w of normalise(value).trim().split(" ")) {
      if (w.length < 2 || (!includeCommon && NOT_DISTINCTIVE.has(w))) continue;
      (owners.get(w) ?? owners.set(w, new Set()).get(w)!).add(value);
    }
  }
  const unique = new Map<string, string>();
  for (const [w, vs] of owners) if (vs.size === 1) unique.set(w, [...vs][0]!);
  return unique;
}

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
  if (best) return best;

  // Nothing matched in full, so fall back to the one word that tells the options
  // apart. Lower confidence than a full match, but above the default threshold:
  // "next" is not ambiguous among these three, it is just short.
  const hits = new Set<string>();
  for (const [w, value] of distinctiveWords(values)) {
    if (haystack.includes(` ${w} `)) hits.add(value);
  }
  if (hits.size !== 1) return null;

  // Two options named at once ("next or this one, not sure") is a genuine
  // ambiguity, and guessing between them would be worse than asking again. The
  // common words count here even though they cannot identify an option alone:
  // "this" is too weak to mean `this_intake`, but strong enough to doubt `next`.
  const mentioned = new Set<string>();
  for (const [w, value] of distinctiveWords(values, { includeCommon: true })) {
    if (haystack.includes(` ${w} `)) mentioned.add(value);
  }
  if (mentioned.size > 1) return null;
  return { value: [...hits][0]!, confidence: 0.8, specificity: 0 };
}

/** Replies that decline to answer, so they are never recorded as one. */
const NON_ANSWER =
  /^(?:dunno|don'?t know|do not know|no idea|not sure|unsure|n\/?a|none|nothing|skip|pass|maybe|idk)\b/i;

/**
 * A free-text field has no vocabulary to match, so the only honest reading
 * without a model is positional: the lead's reply to a question that named the
 * field is the answer to it. Anything looser would take "B.Tech" as someone's
 * budget.
 *
 * Without this every string field was invisible offline, so an agent that asked
 * for a prior qualification and got "B.Tech" asked again.
 */
function replyTo(turns: Turn[], field: string): string | null {
  const words = normalise(field).trim().split(" ");
  for (let i = turns.length - 1; i > 0; i--) {
    const reply = turns[i]!;
    const question = turns[i - 1]!;
    if (reply.role !== "lead" || question.role !== "agent") continue;
    const asked = normalise(question.text);
    if (!words.every((w) => asked.includes(` ${w} `))) continue;
    const text = reply.text.trim();
    if (text === "" || NON_ANSWER.test(text)) return null;
    return text;
  }
  return null;
}
