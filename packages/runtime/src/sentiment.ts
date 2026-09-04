import type { Turn } from "@midfunnel/core/events/types";

export interface SentimentResult {
  score: number;   // -1 (hostile) .. +1 (delighted)
  reason: string;
}

const NEGATIVE = [
  "terrible", "useless", "awful", "horrible", "rubbish", "waste", "scam",
  "annoying", "frustrating", "frustrated", "angry", "stupid", "worst",
  "unacceptable", "ridiculous", "disappointed", "misleading",
];

const POSITIVE = [
  "great", "perfect", "excellent", "wonderful", "brilliant", "helpful",
  "thanks", "thank", "awesome", "love", "good", "interested", "keen",
];

/**
 * Deterministic lexicon sentiment over LEAD turns only.
 *
 * Weaker than a model, and deliberately so: it runs on every step of every
 * conversation, it must be free, and it must be reproducible for replay. Its
 * one job is deciding whether a declared `sentiment` policy rule fires. When
 * nuance matters, the eval judge scores the same conversation with the
 * flagship model.
 */
export class LexiconSentiment {
  analyze(turns: Turn[]): SentimentResult {
    const lead = turns.filter((t) => t.role === "lead");
    if (lead.length === 0) return { score: 0, reason: "no lead turns" };

    let weighted = 0;
    let weightSum = 0;

    lead.forEach((turn, i) => {
      // Recency weighting: a lead who has calmed down is no longer an escalation.
      const weight = (i + 1) / lead.length;
      const words = turn.text.toLowerCase().split(/[^a-z']+/).filter(Boolean);
      let hits = 0;
      let sum = 0;
      for (const w of words) {
        if (NEGATIVE.includes(w)) { sum -= 1; hits++; }
        else if (POSITIVE.includes(w)) { sum += 1; hits++; }
      }
      if (hits > 0) {
        // Saturating: three negative words is angry; ten is not 3x angrier.
        weighted += weight * Math.tanh(sum / 2);
        weightSum += weight;
      }
    });

    if (weightSum === 0) return { score: 0, reason: "no sentiment-bearing terms" };

    const score = Math.max(-1, Math.min(1, weighted / weightSum));
    const reason =
      score < -0.3 ? "negative terms dominate recent lead turns"
      : score > 0.3 ? "positive terms dominate recent lead turns"
      : "mixed or weak signal";
    return { score: Math.round(score * 100) / 100, reason };
  }
}
