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
