import { readFileSync } from "node:fs";
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

/** Names of variables this process took from .env rather than the environment. */
const fromEnvFile = new Set<string>();

/**
 * Loads .env, overriding any variable already present in the environment.
 *
 * Node's own `process.loadEnvFile` does NOT override, and neither does dotenv
 * by default — the convention assumes real environment variables were set
 * deliberately by a deploy platform. Locally that assumption inverts: a GUI
 * app can hand a process a stale credential it never asked for, and a project
 * .env someone deliberately created is the more trustworthy signal. Silently
 * preferring the ambient value is a very expensive hour to lose, so the file
 * wins here and `credentialFingerprint()` reports which source was used.
 */
export function loadEnvFile(path = ".env"): string[] {
  // Each call reflects only what IT applied, so a later load with a different
  // file cannot leave this reporting a stale source.
  fromEnvFile.clear();

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch {
    return []; // No .env is fine; the environment may supply the key.
  }

  const applied: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const name = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    process.env[name] = value;
    fromEnvFile.add(name);
    applied.push(name);
  }
  return applied;
}

/**
 * A safe identifier for whichever credential is in play: length and last four
 * characters only, never the key. Enough to tell two keys apart when a process
 * inherits one from an environment you cannot see, which is otherwise very
 * hard to debug.
 */
export function credentialFingerprint(): string {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return "none";
  const source = fromEnvFile.has("OPENAI_API_KEY") ? ".env" : "inherited environment";
  return `${key.length} chars, ending ${key.slice(-4)} (from ${source})`;
}
