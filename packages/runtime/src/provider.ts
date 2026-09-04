import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, parse } from "node:path";
import OpenAI from "openai";

/**
 * Exact model ids. Never invent a variant or append a suffix.
 *
 * Prices per 1M tokens (input / cached input / output):
 *   gpt-6-astra    $10 / $1.00 / $50
 *   gpt-5.6-sol     $4 / $0.40 / $20
 *   gpt-5.6-terra   $2 / $0.20 / $12
 *   gpt-5.6-luna  $0.20 / $0.02 / $1.20
 */
export const MODELS = {
  astra: "gpt-6-astra",
  sol: "gpt-5.6-sol",
  terra: "gpt-5.6-terra",
  luna: "gpt-5.6-luna",
} as const;

export type Tier = keyof typeof MODELS;

/**
 * USD per token, so a cost is a multiplication rather than a unit conversion
 * at each call site. Kept beside the ids because a price that drifts from the
 * model it prices is worse than no price at all.
 */
export const PRICES: Record<string, { input: number; cachedInput: number; output: number }> = {
  [MODELS.astra]: { input: 10 / 1e6, cachedInput: 1.0 / 1e6, output: 50 / 1e6 },
  [MODELS.sol]:   { input:  4 / 1e6, cachedInput: 0.40 / 1e6, output: 20 / 1e6 },
  [MODELS.terra]: { input:  2 / 1e6, cachedInput: 0.20 / 1e6, output: 12 / 1e6 },
  [MODELS.luna]:  { input: 0.20 / 1e6, cachedInput: 0.02 / 1e6, output: 1.20 / 1e6 },
};

/** The subset of the Responses API usage object that costing needs. */
export interface TokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
  output_tokens_details?: { reasoning_tokens?: number };
}

export interface CallCost {
  model: string;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  usd: number;
  /** False when the model id carries no published price, so totals stay honest. */
  priced: boolean;
}

/**
 * Reasoning tokens are billed as output and are the dominant term — on a real
 * extraction call output ran ~25x input, which is why reasoning effort, not
 * prompt caching, is the cost lever worth tuning.
 */
export function costOf(model: string, usage: TokenUsage | undefined): CallCost {
  const input = usage?.input_tokens ?? 0;
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0;
  const output = usage?.output_tokens ?? 0;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens ?? 0;
  const p = PRICES[model];

  return {
    model,
    inputTokens: input,
    cachedTokens: cached,
    outputTokens: output,
    reasoningTokens: reasoning,
    usd: p ? (input - cached) * p.input + cached * p.cachedInput + output * p.output : 0,
    priced: Boolean(p),
  };
}

/** Ascending capability. Used to enforce that a judge is never weaker. */
const STRENGTH: Record<Tier, number> = { luna: 1, terra: 2, sol: 3, astra: 4 };

export type Role = "runtime" | "extractor" | "judge" | "persona" | "insights" | "copilot";

/**
 * `dev` is the default: terra everywhere while building, debugging and
 * iterating on A/B experiments. Roughly 40% of sol's cost, and quality
 * differences between versions still show up because both arms run the same
 * model — a comparison is internally consistent at any tier.
 *
 * `demo` upgrades the two roles an audience actually judges — the agent's own
 * conversation and the judge scoring it — and drops personas to luna, which is
 * the volume driver and needs plausibility rather than brilliance.
 */
export const PROFILES: Record<string, Record<Role, Tier>> = {
  dev:  { runtime: "terra", extractor: "terra", judge: "terra", persona: "terra",
          insights: "terra", copilot: "terra" },
  demo: { runtime: "sol",   extractor: "terra", judge: "sol",   persona: "luna",
          insights: "sol",   copilot: "sol" },
};

const ROLE_ENV: Record<Role, string> = {
  runtime: "MODEL_RUNTIME",
  extractor: "MODEL_EXTRACTOR",
  judge: "MODEL_JUDGE",
  persona: "MODEL_PERSONA",
  insights: "MODEL_INSIGHTS",
  copilot: "MODEL_COPILOT",
};

export function activeProfile(): string {
  const name = process.env.MODEL_PROFILE ?? "dev";
  return name in PROFILES ? name : "dev";
}

/** Resolves the model for a role: per-role env override, else the profile. */
export function modelFor(role: Role): string {
  const override = process.env[ROLE_ENV[role]];
  if (override) return override;
  return MODELS[PROFILES[activeProfile()]![role]];
}

function tierOf(id: string): Tier | null {
  const hit = (Object.entries(MODELS) as Array<[Tier, string]>).find(([, v]) => v === id);
  return hit ? hit[0] : null;
}

/**
 * A judge weaker than the thing it judges measures the judge, not the agent.
 * Returns a warning rather than throwing: an unrecognised custom model id is
 * not necessarily wrong, and refusing to start over a model choice would be
 * worse than saying so loudly.
 */
export function judgeWeakerThanJudged(): string | null {
  const judge = tierOf(modelFor("judge"));
  const runtime = tierOf(modelFor("runtime"));
  if (!judge || !runtime) return null;
  if (STRENGTH[judge] >= STRENGTH[runtime]) return null;
  return `judge (${modelFor("judge")}) is weaker than the runtime it scores ` +
         `(${modelFor("runtime")}). Eval results will measure the judge, not the agent.`;
}

/** Human-readable summary for startup logging. */
export function describeModels(): string {
  const roles: Role[] = ["runtime", "extractor", "judge", "persona", "insights", "copilot"];
  return `profile=${activeProfile()} ` +
    roles.map((r) => `${r}=${modelFor(r)}`).join(" ");
}


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
 *
 * The file is searched for from the working directory upward, because in a
 * workspace `npm run start -w @midfunnel/web` runs with cwd inside the package
 * and the .env lives at the repo root. Resolving only against cwd means the
 * file is quietly not found in exactly the case people run most.
 */
export function loadEnvFile(path = ".env"): string[] {
  // Each call reflects only what IT applied, so a later load with a different
  // file cannot leave this reporting a stale source.
  fromEnvFile.clear();
  envFilePath = null;

  const found = isAbsolute(path) ? path : findUpward(path);
  if (!found) return []; // No .env is fine; the environment may supply the key.

  let text: string;
  try {
    text = readFileSync(found, "utf8");
  } catch {
    return [];
  }
  envFilePath = found;

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
  const source = fromEnvFile.has("OPENAI_API_KEY")
    ? (envFilePath ?? ".env")
    : "inherited environment";
  const suffix = isPlaceholder(key) ? " — PLACEHOLDER, not a real key" : "";
  return `${key.length} chars, ending ${key.slice(-4)} (from ${source})${suffix}`;
}

/**
 * `.env.example` ships a placeholder and people copy it. Because loadEnvFile
 * OVERRIDES the inherited environment, a copied placeholder beats a real key
 * and every call 401s — with the confusing symptom that a credential is
 * clearly present. Recognise the shape and treat it as absent.
 */
/** Absolute path of the .env actually applied, for honest reporting. */
let envFilePath: string | null = null;

function findUpward(name: string): string | null {
  let dir = process.cwd();
  const root = parse(dir).root;
  for (;;) {
    const candidate = join(dir, name);
    try {
      readFileSync(candidate, "utf8");
      return candidate;
    } catch { /* keep walking */ }
    if (dir === root) return null;
    dir = dirname(dir);
  }
}

export function isPlaceholder(key: string): boolean {
  return /^(your|sk-\.\.\.|<|xxx|changeme|replace)/i.test(key.trim())
      || /(-|_)?(KEY|HERE|PLACEHOLDER|TODO)$/.test(key.trim())
      || key.includes("...");
}

/**
 * The single answer to "can this process call the model?". Every caller used to
 * ask `Boolean(process.env.OPENAI_API_KEY)` and each one would have been fooled
 * by a placeholder.
 */
export function hasCredential(): boolean {
  const key = process.env.OPENAI_API_KEY;
  return Boolean(key) && !isPlaceholder(key!);
}
