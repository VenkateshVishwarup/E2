import { requiredEvidenceFields, type JourneySpec } from "@midfunnel/core/journey/spec";

export interface Evidence { [field: string]: { value: unknown; confidence: number } }

export interface RouteResult { decision: string; target: string; sla?: string }

export interface PredicateContext { score: number; evidenceComplete: boolean }

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
 * `otherwise`. Joined with AND / OR.
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

  throw new Error(`unsupported predicate: ${expr}`);
}

/** First rule in declaration order wins. */
export function route(spec: JourneySpec, s: number): RouteResult {
  for (const [decision, rule] of Object.entries(spec.routing)) {
    if (evaluatePredicate(rule.when, { score: s, evidenceComplete: true })) {
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
