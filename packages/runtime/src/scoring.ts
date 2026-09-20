import { requiredEvidenceFields, type JourneySpec } from "@midfunnel/core/journey/spec";

export interface Evidence { [field: string]: { value: unknown; confidence: number } }

export interface RouteResult { decision: string; target: string; sla?: string }

export interface PredicateContext {
  score: number;
  evidenceComplete: boolean;
  /** -1..1. Absent means neutral, so a sentiment rule simply does not fire. */
  sentiment?: number;
  /** Established evidence, so a rule can branch on what the lead actually said. */
  evidence?: Evidence;
}

/** Weight keys are `field.value`, or `field.*` for any established value. */
export function score(spec: JourneySpec, evidence: Evidence): number {
  let total = 0;
  for (const [key, weight] of Object.entries(spec.scoring.weights)) {
    const dot = key.lastIndexOf(".");
    if (dot === -1) continue;
    const field = key.slice(0, dot);
    const want = key.slice(dot + 1);
    const got = evidence[field];
    if (!got || got.value === null || got.value === undefined) continue;
    if (want === "*" || String(got.value) === want) total += weight;
  }
  return Math.min(100, Math.round(total));
}

/**
 * A deliberately tiny evaluator. Specs are authored data, not code — running
 * them through `eval` would put remote code execution in the runtime.
 * Supported atoms: `score <op> <number>`, `evidence.complete(required)`,
 * `evidence.<field> == <value>`, `sentiment <op> <number>`, `otherwise`.
 * Joined with AND / OR.
 */
export function evaluatePredicate(expr: string, ctx: PredicateContext): boolean {
  const trimmed = expr.trim();
  if (trimmed.toLowerCase() === "otherwise") return true;

  if (/\sOR\s/.test(trimmed)) {
    return trimmed.split(/\sOR\s/).some((part) => evaluatePredicate(part, ctx));
  }
  if (/\sAND\s/.test(trimmed)) {
    return trimmed.split(/\sAND\s/).every((part) => evaluatePredicate(part, ctx));
  }

  if (trimmed === "evidence.complete(required)") return ctx.evidenceComplete;

  // Branching on what the lead said, not only on the score it produced. A
  // journey that can only route on a scalar cannot express "these leads need a
  // different conversation", which is the most common thing a marketer wants.
  const em = /^evidence\.(\w+)\s*(==|!=)\s*(\S+)$/.exec(trimmed);
  if (em) {
    const got = ctx.evidence?.[em[1]!];
    const actual = got?.value === null || got?.value === undefined ? null : String(got.value);
    const matches = actual !== null && actual === em[3];
    return em[2] === "==" ? matches : !matches;
  }

  const m = /^score\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (m) {
    const n = Number(m[2]);
    switch (m[1]) {
      case ">=": return ctx.score >= n;
      case "<=": return ctx.score <= n;
      case ">":  return ctx.score > n;
      case "<":  return ctx.score < n;
      case "==": return ctx.score === n;
    }
  }

  const sm = /^sentiment\s*(>=|<=|>|<|==)\s*(-?\d+(?:\.\d+)?)$/.exec(trimmed);
  if (sm) {
    const n = Number(sm[2]);
    const v = ctx.sentiment ?? 0;
    switch (sm[1]) {
      case ">=": return v >= n;
      case "<=": return v <= n;
      case ">":  return v > n;
      case "<":  return v < n;
      case "==": return v === n;
    }
  }

  throw new Error(`unsupported predicate: ${expr}`);
}

/**
 * First rule in declaration order wins.
 *
 * `evidence` is required rather than optional: a routing rule that branches on
 * evidence would silently never fire for any caller that forgot to pass it,
 * which is the same class of bug as the JSONB key reordering that once routed
 * every warm lead cold.
 */
export function route(spec: JourneySpec, s: number, evidence: Evidence): RouteResult {
  for (const [decision, rule] of Object.entries(spec.routing)) {
    if (evaluatePredicate(rule.when, { score: s, evidenceComplete: true, evidence })) {
      return { decision, target: rule.target, ...(rule.sla ? { sla: rule.sla } : {}) };
    }
  }
  throw new Error(`no routing rule matched score ${s} — every journey needs an "otherwise" rule`);
}

export function evidenceComplete(spec: JourneySpec, evidence: Evidence): boolean {
  return requiredEvidenceFields(spec).every((f) => {
    const got = evidence[f];
    return got !== undefined && got.value !== null && got.value !== undefined;
  });
}

export function qualifies(spec: JourneySpec, s: number, evidence: Evidence): boolean {
  return evaluatePredicate(spec.objective.qualifies_when, {
    score: s,
    evidenceComplete: evidenceComplete(spec, evidence),
  });
}

/** Fields with nothing established, in declaration order. */
export function missingFields(spec: JourneySpec, evidence: Evidence): string[] {
  return Object.keys(spec.evidence).filter((f) => !established(evidence, f));
}

export function established(evidence: Evidence, field: string): boolean {
  const got = evidence[field];
  return got !== undefined && got.value !== null && got.value !== undefined;
}

/**
 * Which field a scripted journey asks for next: required before optional, and a
 * `sensitive` field is never asked while nothing at all is established — you do
 * not open with money.
 *
 * Lives here rather than in `step()` because the guardrail needs the same answer.
 * When an open agent's proposed `ask` is rejected, the fallback must be the field
 * the scripted strategy would have chosen, or the two strategies stop being
 * comparable at exactly the moments that matter.
 *
 * Returns null when nothing is left to ask for. `exclude` removes fields the
 * agent has already asked for as often as it may.
 */
export function nextField(
  spec: JourneySpec, evidence: Evidence, exclude: ReadonlySet<string> = new Set(),
): string | null {
  const missing = missingFields(spec, evidence).filter((f) => !exclude.has(f));
  if (missing.length === 0) return null;
  const nothingEstablished = Object.keys(evidence).length === 0;

  const eligible = missing.filter((f) => !(spec.evidence[f]!.sensitive && nothingEstablished));
  const pool = eligible.length > 0 ? eligible : missing;

  return pool.find((f) => spec.evidence[f]!.required) ?? pool[0]!;
}

/**
 * Whether the agent has collected everything this journey asks it to.
 *
 * The one place the `collect` policy is interpreted, so the scripted strategy,
 * the planner and the guardrail cannot disagree about when a conversation is
 * finished. `exclude` carries fields the agent has already asked for as often as
 * it may: a question that will not land must not hold a conversation open.
 */
export function collectionComplete(
  spec: JourneySpec, evidence: Evidence, exclude: ReadonlySet<string> = new Set(),
): boolean {
  // `all` is strictly stronger than `required`, never weaker. Asking only
  // "is there anything left to ask?" would report a conversation as finished
  // when the one field it could not get was a required one — `exclude` removes
  // it from the queue, and without this it would vanish from the check too.
  if (!evidenceComplete(spec, evidence)) return false;
  return spec.objective.collect === "all"
    ? nextField(spec, evidence, exclude) === null
    : true;
}
