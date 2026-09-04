import { EVENT_TYPES, type EventType, type StoredEvent } from "../events/types.js";

/**
 * `metrics:` is a different language from `routing.when`, and conflating them
 * is the trap this module exists to avoid. A routing predicate asks a question
 * about one lead's *score*; a metric asks a question about one lead's *event
 * history*. They share the no-`eval` discipline and nothing else.
 *
 * Grammar:
 *
 *   metric    := aggregate | boolean
 *   aggregate := ("sum"|"count"|"avg") "(" Type ["." field] ["where" cond] ")"
 *   boolean   := Type "exists"
 *              | Type "." field OP literal
 *              | Type "." field "in" "[" literal, ... "]"
 *              | boolean ("AND" | "OR") boolean
 */

export type CompareOp = "==" | "!=" | ">=" | "<=" | ">" | "<";
export type Literal = string | number | boolean;

export interface Condition { field: string; op: CompareOp; value: Literal }

export type MetricAst =
  | { kind: "exists"; type: EventType }
  | { kind: "compare"; type: EventType; cond: Condition }
  | { kind: "in"; type: EventType; field: string; values: Literal[] }
  | { kind: "and"; left: MetricAst; right: MetricAst }
  | { kind: "or"; left: MetricAst; right: MetricAst }
  | { kind: "aggregate"; fn: "sum" | "count" | "avg"; type: EventType; field?: string; where?: Condition };

/**
 * Two kinds, and the distinction is load-bearing. A boolean metric aggregates
 * as a *count of leads*; an aggregate metric aggregates as a *sum over leads*.
 * One evaluator returning `number` for both would make revenue-per-lead
 * silently wrong, because `qualified_lead` would contribute rupees.
 */
export type MetricKind = "boolean" | "aggregate";

export function metricKind(ast: MetricAst): MetricKind {
  return ast.kind === "aggregate" ? "aggregate" : "boolean";
}

const OPS: CompareOp[] = ["==", "!=", ">=", "<=", ">", "<"];
const AGGREGATE = /^(sum|count|avg)\s*\(([^)]*)\)$/i;

function asEventType(name: string, expr: string): EventType {
  const found = EVENT_TYPES.find((t) => t === name);
  if (!found) {
    // A typo that quietly evaluated false would under-report conversion
    // forever, and nobody would notice until a customer disputed an invoice.
    throw new Error(
      `unknown event type "${name}" in metric: ${expr}. ` +
      `Known types: ${EVENT_TYPES.join(", ")}`,
    );
  }
  return found;
}

function literal(raw: string): Literal {
  const t = raw.trim().replace(/^["']|["']$/g, "");
  if (t === "true") return true;
  if (t === "false") return false;
  if (t !== "" && !Number.isNaN(Number(t))) return Number(t);
  return t;
}

function condition(raw: string, expr: string): Condition {
  for (const op of OPS) {
    const at = raw.indexOf(op);
    if (at === -1) continue;
    // `>=` must not be read as `>`; OPS is ordered so the two-character forms
    // are tried first, but a `>` found earlier in the string still wins, so
    // check that this is not the head of a longer operator.
    if (op.length === 1 && raw[at + 1] === "=") continue;
    return {
      field: raw.slice(0, at).trim(),
      op,
      value: literal(raw.slice(at + op.length)),
    };
  }
  throw new Error(`condition needs a comparison operator: ${expr}`);
}

export function parseMetric(expr: string): MetricAst {
  const trimmed = expr.trim();
  if (!trimmed) throw new Error("empty metric expression");

  const agg = AGGREGATE.exec(trimmed);
  if (agg) {
    const fn = agg[1]!.toLowerCase() as "sum" | "count" | "avg";
    const [subjectPart, wherePart] = agg[2]!.split(/\s+where\s+/i);
    const [typeName, ...rest] = subjectPart!.trim().split(".");
    const type = asEventType(typeName!.trim(), expr);
    const field = rest.join(".").trim() || undefined;

    if (fn !== "count" && !field) {
      throw new Error(`${fn}() needs a field to aggregate, e.g. ${fn}(${type}.amount)`);
    }
    return {
      kind: "aggregate", fn, type,
      ...(field ? { field } : {}),
      ...(wherePart ? { where: condition(wherePart, expr) } : {}),
    };
  }

  // Boolean composition. Aggregates are excluded above, so a bare OR/AND here
  // can only be joining boolean atoms.
  const or = splitTop(trimmed, "OR");
  if (or) return { kind: "or", left: parseMetric(or[0]), right: parseMetric(or[1]) };
  const and = splitTop(trimmed, "AND");
  if (and) return { kind: "and", left: parseMetric(and[0]), right: parseMetric(and[1]) };

  const existsMatch = /^([A-Za-z]+)\s+exists$/.exec(trimmed);
  if (existsMatch) return { kind: "exists", type: asEventType(existsMatch[1]!, expr) };

  const inMatch = /^([A-Za-z]+)\.([A-Za-z_][\w.]*)\s+in\s*\[([^\]]*)\]$/i.exec(trimmed);
  if (inMatch) {
    return {
      kind: "in",
      type: asEventType(inMatch[1]!, expr),
      field: inMatch[2]!,
      values: inMatch[3]!.split(",").map(literal).filter((v) => v !== ""),
    };
  }

  const dot = trimmed.indexOf(".");
  if (dot > 0) {
    const type = asEventType(trimmed.slice(0, dot).trim(), expr);
    return { kind: "compare", type, cond: condition(trimmed.slice(dot + 1), expr) };
  }

  throw new Error(`unsupported metric expression: ${expr}`);
}

/** Split on a top-level keyword, ignoring anything inside parentheses or brackets. */
function splitTop(expr: string, keyword: string): [string, string] | null {
  const re = new RegExp(`\\s${keyword}\\s`, "i");
  let depth = 0;
  for (let i = 0; i < expr.length; i++) {
    const c = expr[i]!;
    if (c === "(" || c === "[") depth++;
    else if (c === ")" || c === "]") depth--;
    else if (depth === 0 && re.test(expr.slice(i, i + keyword.length + 2))) {
      return [expr.slice(0, i), expr.slice(i + keyword.length + 2)];
    }
  }
  return null;
}

function compare(actual: unknown, op: CompareOp, expected: Literal): boolean {
  if (actual === null || actual === undefined) return false;
  const a = typeof expected === "number" ? Number(actual) : String(actual);
  const b = expected;
  switch (op) {
    case "==": return a === b;
    case "!=": return a !== b;
    case ">=": return Number(a) >= Number(b);
    case "<=": return Number(a) <= Number(b);
    case ">":  return Number(a) > Number(b);
    case "<":  return Number(a) < Number(b);
  }
}

/**
 * Comparisons are *existential*: `Routed.decision == hot` is true when any
 * `Routed` event for this lead routed hot. A lead re-scored and re-routed
 * counts as qualified if it was ever routed hot, which is what a marketer
 * means by the phrase.
 */
export function evaluateMetric(ast: MetricAst, events: readonly StoredEvent[]): boolean | number {
  switch (ast.kind) {
    case "and": return Boolean(evaluateMetric(ast.left, events)) && Boolean(evaluateMetric(ast.right, events));
    case "or":  return Boolean(evaluateMetric(ast.left, events)) || Boolean(evaluateMetric(ast.right, events));
    case "exists": return events.some((e) => e.type === ast.type);

    case "compare":
      return events.some((e) => e.type === ast.type &&
        compare(e.payload[ast.cond.field], ast.cond.op, ast.cond.value));

    case "in":
      return events.some((e) => {
        if (e.type !== ast.type) return false;
        const v = e.payload[ast.field];
        return v !== null && v !== undefined && ast.values.some((w) => String(w) === String(v));
      });

    case "aggregate": {
      const matching = events.filter((e) => {
        if (e.type !== ast.type) return false;
        if (ast.where && !compare(e.payload[ast.where.field], ast.where.op, ast.where.value)) return false;
        if (ast.field && (e.payload[ast.field] === null || e.payload[ast.field] === undefined)) return false;
        return true;
      });

      if (ast.fn === "count") return matching.length;
      const values = matching.map((e) => Number(e.payload[ast.field!] ?? 0));
      const sum = values.reduce((a, b) => a + b, 0);
      if (ast.fn === "sum") return sum;
      return values.length === 0 ? 0 : sum / values.length;
    }
  }
}

export interface EvaluatedMetrics {
  booleans: Record<string, boolean>;
  aggregates: Record<string, number>;
}

/** Evaluate every declared metric for one lead, kept separated by kind. */
export function evaluateAll(
  metrics: Record<string, string>,
  events: readonly StoredEvent[],
): EvaluatedMetrics {
  const out: EvaluatedMetrics = { booleans: {}, aggregates: {} };
  for (const [name, expr] of Object.entries(metrics)) {
    const ast = parseMetric(expr);
    const value = evaluateMetric(ast, events);
    if (metricKind(ast) === "aggregate") out.aggregates[name] = Number(value);
    else out.booleans[name] = Boolean(value);
  }
  return out;
}
