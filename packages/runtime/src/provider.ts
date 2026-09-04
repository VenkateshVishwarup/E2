import OpenAI from "openai";

/**
 * Exact model ids. Never invent a variant or append a suffix.
 *
 * gpt-5.6-sol  $4 / $0.40 cached / $20 per 1M — runtime, extraction, judging.
 * gpt-5.6-terra $2 / $0.20 cached / $12 per 1M — persona simulation only, the
 *   one justified downgrade: personas need plausibility, not brilliance, and
 *   they are the volume driver in a simulation run.
 *
 * gpt-6-astra exists and is stronger, at $10/$50. Not the default: the judge
 * only has to be at least as strong as the thing it judges, and if both are
 * sol that holds.
 */
export const MODEL = "gpt-5.6-sol" as const;
export const PERSONA_MODEL = "gpt-5.6-terra" as const;

/** Ceiling on GENERATED tokens only — not a whole-request budget. */
export const MAX_TOKENS = 16000;

export function createClient(): OpenAI {
  // Resolves OPENAI_API_KEY from the environment. Never hardcode a key.
  return new OpenAI();
}

/**
 * Routing hint for prompt caching.
 *
 * There is no explicit cache breakpoint to place: the platform caches on prefix
 * match automatically and `prompt_cache_key` only steers requests toward the
 * same cache. So the ordering discipline matters more, not less — the
 * journey spec must stay at the very front of `instructions`, byte-identical
 * across every conversation in a run, with volatile content only in `input`.
 */
export function cacheKey(journey: string, version: number): string {
  return `${journey}@${version}`;
}

/** Loads .env if present. Node built-in — no dotenv dependency. */
export function loadEnvFile(path = ".env"): void {
  try {
    process.loadEnvFile(path);
  } catch {
    // Absent or unreadable .env is fine; the environment may supply the key.
  }
}
