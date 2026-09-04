import { parseTypeExpr, type JourneySpec } from "@midfunnel/core/journey/spec";
import { mulberry32 } from "../replay/stats.js";

export interface Persona {
  id: string;
  /** Ground truth. The runtime never sees this — only the replies it shapes. */
  truth: Record<string, string>;
  verbosity: "terse" | "normal" | "chatty";
  /** 0..1 probability of answering a question directly rather than deflecting. */
  cooperation: number;
  objection: "none" | "price" | "time" | "trust";
  /** Ghosts after this many lead turns. null means they see it through. */
  dropoffAfterTurn: number | null;
  mood: "positive" | "neutral" | "frustrated";
}

const VERBOSITY = ["terse", "normal", "chatty"] as const;
const OBJECTIONS = ["none", "price", "time", "trust"] as const;
const MOODS = ["positive", "neutral", "frustrated"] as const;

/**
 * Deterministic for a seed, so a simulation run is reproducible and an A/B
 * comparison is paired: the same personas meet both journey versions.
 *
 * Truth is drawn only from enum fields — free-text evidence cannot be scored
 * for correctness by exact match, so seeding it would create a metric that
 * looks meaningful and is not.
 */
export function generatePersonas(spec: JourneySpec, n: number, seed = 1): Persona[] {
  const rand = mulberry32(seed);
  const pick = <T,>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)]!;

  const enumFields = Object.entries(spec.evidence)
    .map(([field, def]) => [field, def, parseTypeExpr(def.type)] as const)
    .filter(([, , t]) => t.kind === "enum");

  const personas: Persona[] = [];
  for (let i = 0; i < n; i++) {
    const truth: Record<string, string> = {};
    for (const [field, def, t] of enumFields) {
      if (t.kind !== "enum") continue;
      // Required fields are always established; optional ones sometimes are
      // not, which is what a real cohort looks like.
      if (!def.required && rand() < 0.35) continue;
      truth[field] = pick(t.values);
    }

    personas.push({
      id: `persona_${seed}_${i}`,
      truth,
      verbosity: pick(VERBOSITY),
      cooperation: Math.round(rand() * 100) / 100,
      objection: pick(OBJECTIONS),
      // ~20% ghost partway through — generous to the agent, but enough to make
      // completion rate a meaningful metric.
      dropoffAfterTurn: rand() < 0.2 ? 1 + Math.floor(rand() * 5) : null,
      mood: pick(MOODS),
    });
  }
  return personas;
}
