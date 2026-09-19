import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseMetric, type MetricAst } from "../metrics/predicate.js";
import { MOVES, type Move } from "./moves.js";

export type TypeExpr =
  | { kind: "enum"; values: string[] }
  | { kind: "string" }
  | { kind: "number" }
  | { kind: "boolean" };

/** Parses the mini type syntax used in `evidence:` — `enum[a, b]`, `string`, ... */
export function parseTypeExpr(expr: string): TypeExpr {
  const t = expr.trim();
  if (t === "string" || t === "number" || t === "boolean") return { kind: t };
  const m = /^enum\[([^\]]*)\]$/.exec(t);
  if (!m) throw new Error(`invalid type expression: ${expr}`);
  const values = m[1]!.split(",").map((v) => v.trim()).filter(Boolean);
  if (values.length === 0) throw new Error(`invalid type expression: ${expr}`);
  return { kind: "enum", values };
}

const agentBlock = z.object({
  persona: z.string().min(1),
  identity: z.string().min(1, "agent.identity is required — an agent must be a principal"),
  privileges: z.array(z.string().min(1)).min(1),
  data_scope: z.object({
    read: z.array(z.string()).default([]),
    deny: z.array(z.string()).default([]),
  }).default({ read: [], deny: [] }),
});

const evidenceField = z.object({
  type: z.string(),
  required: z.boolean().default(false),
  confidence_min: z.number().min(0).max(1).default(0.7),
  sensitive: z.boolean().default(false),
  description: z.string().optional(),
  example: z.unknown().optional(),
  maxLength: z.number().int().positive().optional(),
});

const routeRule = z.object({
  when: z.string(),
  target: z.string(),
  sla: z.string().optional(),
});

/**
 * How the agent decides what to do next.
 *
 * `scripted` is the original behaviour and stays the default: the runtime walks
 * the evidence contract in a fixed order and the model only writes the wording
 * of a question whose subject was already chosen in code. Predictable, cheap,
 * auditable — and unable to answer a question, handle an objection, or notice
 * that a lead has stopped cooperating.
 *
 * `open` moves that decision to the model. It chooses a move from a declared
 * repertoire and says why; the guardrail then admits the choice or overrides it.
 * The path becomes non-deterministic. What the agent is PERMITTED to do does not.
 */
const strategyBlock = z.object({
  kind: z.enum(["scripted", "open"]).default("scripted"),
  /** The subset of the repertoire this journey allows. */
  moves: z.array(z.enum(MOVES)).min(1).default([...MOVES]),
  /**
   * Whether the agent may end a conversation before required evidence is
   * complete. Off by default: a model that finds a conversation awkward will
   * reach for the exit, and an early close looks identical in the log to a lead
   * who answered everything.
   */
  allow_unscripted_close: z.boolean().default(false),
  /**
   * How many turns in a row the agent may spend not collecting anything.
   * Without a cap an open agent and a chatty lead will talk pleasantly forever,
   * and every one of those turns is billed.
   */
  max_deflections: z.number().int().nonnegative().default(2),
  /**
   * How many times the agent may ask for any one field. A lead who answers
   * "dunno", or answers in words the extractor cannot place, would otherwise get
   * the same question until the turn budget ran out — a loop that reads as an
   * agent accepting only an exact phrase. Past the limit it moves on, or hands to
   * a human if that field is all that is left.
   */
  max_asks_per_field: z.number().int().positive().default(2),
  /**
   * How hard the planner deliberates before choosing a move.
   *
   * Reasoning effort rather than temperature: the models this runs on reject a
   * temperature parameter outright, and effort is the knob that actually trades
   * cost against judgement. `low` is roughly the price of the question-writing
   * call it replaces; `high` is where a planner starts noticing that a lead has
   * answered a different question than the one it asked.
   */
  reasoning_effort: z.enum(["low", "medium", "high"]).default("medium"),
}).default({});

const rawSpec = z.object({
  journey: z.string().min(1),
  version: z.number().int().positive(),
  vertical: z.string().min(1),
  owner: z.string().min(1),
  agent: agentBlock,
  objective: z.object({ goal: z.string().min(1), qualifies_when: z.string().min(1) }),
  evidence: z.record(evidenceField),
  policy: z.object({
    never: z.array(z.string()).default([]),
    must_disclose: z.string().optional(),
    escalate_when: z.array(z.string()).default([]),
    max_turns: z.number().int().positive().default(20),
    quiet_hours: z.object({ start: z.string(), end: z.string(), tz: z.string() }).optional(),
  }),
  // Pinned text plus, under `variables`, default values for the `{{...}}`
  // placeholders it contains. Branding belongs to the spec author; a lead's
  // own details are supplied per conversation.
  pinned: z.record(z.union([z.string(), z.record(z.string())])).default({}),
  strategy: strategyBlock,
  /**
   * The only facts the agent is allowed to state. Keyed by topic; the value is
   * sent as written.
   *
   * This is what makes an open agent shippable. The move it chooses is the
   * model's; the words of a factual answer are the tenant's. An open agent with
   * an empty knowledge block can hold a conversation and cannot assert anything,
   * which is the correct default for a journey nobody has briefed yet.
   */
  knowledge: z.record(z.string()).default({}),
  scoring: z.object({ weights: z.record(z.number()) }),
  routing: z.record(routeRule),
  tools: z.array(z.object({ capability: z.string().min(1), binding: z.string().min(1) })),
  metrics: z.record(z.string()).default({}),
});

export interface JourneySpec extends z.infer<typeof rawSpec> {
  agent: z.infer<typeof agentBlock> & { dataScope: { read: string[]; deny: string[] } };
}

export function parseSpec(yamlText: string): JourneySpec {
  const parsed = rawSpec.parse(parseYaml(yamlText));

  // Every evidence type expression must be well-formed.
  for (const def of Object.values(parsed.evidence)) parseTypeExpr(def.type);

  // A journey may not declare a tool its agent has no privilege for.
  // Privileges are `capability:scope`; match on the capability half.
  const granted = new Set(parsed.agent.privileges.map((p) => p.split(":")[0]));
  for (const t of parsed.tools) {
    if (!granted.has(t.capability)) {
      throw new Error(
        `tool "${t.capability}" is declared but the agent holds no privilege for it`,
      );
    }
  }

  // Routing is evaluated in declaration order and the first match wins, so an
  // `otherwise` rule anywhere but last would shadow everything after it.
  // Enforce that here rather than leaving it to authoring discipline.
  const rules = Object.entries(parsed.routing);
  const catchAll = rules.filter(([, r]) => r.when.trim().toLowerCase() === "otherwise");
  if (catchAll.length !== 1) {
    throw new Error(
      `routing needs exactly one "otherwise" rule, found ${catchAll.length}`,
    );
  }
  if (rules[rules.length - 1]![0] !== catchAll[0]![0]) {
    throw new Error(
      `routing rule "${catchAll[0]![0]}" is "otherwise" but is not declared last; ` +
      `it would shadow every rule after it`,
    );
  }

  // `read` and `deny` carry zod defaults, so they are always present after
  // parsing — but they are optional on the schema's input type, and a spread
  // widens to that. Naming them keeps the guarantee the type claims.
  const { read, deny } = parsed.agent.data_scope;
  return { ...parsed, agent: { ...parsed.agent, dataScope: { read, deny } } };
}

/** Variables the runtime supplies per conversation rather than the spec. */
export const RUNTIME_VARIABLES = ["name"] as const;

export function pinnedText(spec: JourneySpec, key: string): string | undefined {
  const v = spec.pinned[key];
  return typeof v === "string" ? v : undefined;
}

export function pinnedDefaults(spec: JourneySpec): Record<string, string> {
  const v = spec.pinned.variables;
  return typeof v === "object" && v !== null ? v : {};
}

/**
 * Substitutes `{{placeholders}}` in pinned text.
 *
 * Unresolved placeholders are reported rather than sent: a lead receiving
 * "Hi {{name}}" is a worse failure than a slightly generic greeting, and it is
 * the kind of thing nobody notices in a spec review.
 */
export function renderPinned(
  template: string, values: Record<string, string>,
): { text: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const text = template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (_, key: string) => {
    const value = values[key];
    if (value !== undefined && value !== "") return value;
    unresolved.push(key);
    return "";
  });
  // Collapse the whitespace a removed placeholder leaves behind, and tidy the
  // punctuation that was leaning on it.
  return { text: text.replace(/\s{2,}/g, " ").replace(/\s+([,.!?])/g, "$1").trim(), unresolved };
}

export function requiredEvidenceFields(spec: JourneySpec): string[] {
  return Object.entries(spec.evidence).filter(([, d]) => d.required).map(([f]) => f);
}

/** True when the model, not `nextField()`, chooses what happens next. */
export function isOpen(spec: JourneySpec): boolean {
  return spec.strategy.kind === "open";
}

export function allowedMoves(spec: JourneySpec): Move[] {
  return [...spec.strategy.moves];
}

export function moveAllowed(spec: JourneySpec, move: string): move is Move {
  return (spec.strategy.moves as readonly string[]).includes(move);
}

/** The fact behind a knowledge key, or undefined if the journey never declared one. */
export function knowledgeEntry(spec: JourneySpec, key: string): string | undefined {
  return spec.knowledge[key];
}

export function knowledgeKeys(spec: JourneySpec): string[] {
  return Object.keys(spec.knowledge);
}

/**
 * Anything that looks like a quoted amount.
 *
 * Deliberately broad, and only ever applied to text the MODEL wrote — a journey
 * whose policy forbids quoting fees may still declare a fee in `knowledge`,
 * because that text is the tenant's own and is sent verbatim. The rule exists to
 * stop the agent improvising a number around it.
 */
export const FIGURE =
  /(?:[$£€₹]\s?\d|(?:USD|INR|EUR|GBP|Rs\.?)\s?\d|\d[\d,.]*\s?(?:%|k\b|L\b|lakhs?|crores?|cr\b|USD|INR|EUR|GBP))/i;

/**
 * The evidence block IS a JSON Schema. This is why Approach B works and a
 * prompt-based approach cannot: the API guarantees conformance.
 *
 * Every field is `required` with a nullable value rather than optional, so the
 * model must explicitly report "not established" instead of silently omitting.
 */
export function evidenceToJsonSchema(spec: JourneySpec): Record<string, unknown> {
  const properties: Record<string, unknown> = {};

  for (const [field, def] of Object.entries(spec.evidence)) {
    const t = parseTypeExpr(def.type);
    const value =
      t.kind === "enum"
        ? { type: ["string", "null"], enum: [...t.values, null] }
        : t.kind === "string"
          ? { type: ["string", "null"], ...(def.maxLength ? { maxLength: def.maxLength } : {}) }
          : { type: [t.kind, "null"] };

    properties[field] = {
      type: "object",
      additionalProperties: false,
      required: ["value", "confidence"],
      description: def.description ?? `Evidence field ${field}`,
      properties: {
        value,
        confidence: { type: "number", minimum: 0, maximum: 1 },
      },
    };
  }

  return {
    type: "object",
    additionalProperties: false,
    required: Object.keys(spec.evidence),
    properties,
  };
}

export interface SpecWarning {
  code:
    | "unreachable_qualification"
    | "unknown_scoring_field"
    | "unreachable_weight"
    | "unparseable_metric"
    | "unreachable_metric"
    | "unresolvable_template_variable"
    | "unanswerable_open_journey"
    | "unusable_move"
    | "inert_knowledge"
    | "knowledge_contradicts_policy";
  message: string;
}

/**
 * Static checks that catch journeys which cannot do what they claim.
 *
 * Warnings, not errors: a spec may legitimately rely on optional evidence a
 * lead volunteers unprompted. But a journey whose required fields cannot reach
 * its own qualifying threshold will never qualify anyone, and that should be
 * visible at authoring time rather than after a simulation run.
 */
export function lintSpec(spec: JourneySpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  const fields = Object.keys(spec.evidence);

  // Highest weight each field can contribute — a field holds one value, so
  // only its best-scoring value counts.
  const bestPerField = new Map<string, number>();
  for (const [key, weight] of Object.entries(spec.scoring.weights)) {
    const dot = key.lastIndexOf(".");
    if (dot === -1) continue;
    const field = key.slice(0, dot);
    if (!fields.includes(field)) {
      warnings.push({
        code: "unknown_scoring_field",
        message: `scoring weight "${key}" references "${field}", which is not an evidence field`,
      });
      continue;
    }
    bestPerField.set(field, Math.max(bestPerField.get(field) ?? 0, weight));
  }

  const required = requiredEvidenceFields(spec);
  const reachable = required.reduce((sum, f) => sum + (bestPerField.get(f) ?? 0), 0);

  const threshold = scoreThreshold(spec.objective.qualifies_when);
  if (threshold !== null && reachable < threshold) {
    const optional = [...bestPerField.entries()]
      .filter(([f]) => !required.includes(f))
      .map(([f, w]) => `${f} (+${w})`);
    warnings.push({
      code: "unreachable_qualification",
      message:
        `required evidence can score at most ${reachable}, but qualifying needs ${threshold}. ` +
        `The gap depends on optional evidence the runtime stops asking for once required ` +
        `fields are complete: ${optional.join(", ") || "none"}. This journey cannot qualify anyone.`,
    });
  }
  warnings.push(...lintMetrics(spec));
  warnings.push(...lintPinned(spec));
  warnings.push(...lintStrategy(spec));
  return warnings;
}

/**
 * An open journey's moves are only as real as what backs them.
 *
 * A move the guardrail can never admit is worse than an absent one: the planner
 * keeps proposing it, the override fires every time, and the log fills with a
 * disagreement the author never intended.
 */
function lintStrategy(spec: JourneySpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  const moves = new Set(spec.strategy.moves);
  const knowledge = knowledgeKeys(spec);

  if (isOpen(spec)) {
    if (moves.has("answer") && knowledge.length === 0) {
      warnings.push({
        code: "unanswerable_open_journey",
        message:
          'strategy allows the "answer" move but `knowledge` is empty. The agent may only ' +
          "state declared facts, so every question it decides to answer will be overridden " +
          "into a deflection. Declare the facts it should be able to give, or drop the move.",
      });
    }
    if (moves.has("offer") && spec.tools.length === 0) {
      warnings.push({
        code: "unusable_move",
        message:
          'strategy allows the "offer" move but the journey declares no tools. There is ' +
          "nothing for the agent to offer to do.",
      });
    }
    if (moves.size === 1 && moves.has("ask")) {
      warnings.push({
        code: "unusable_move",
        message:
          'strategy is "open" but "ask" is the only permitted move, which is what "scripted" ' +
          "already does — at the cost of an extra model call per turn to arrive at the same " +
          "decision.",
      });
    }
  } else if (knowledge.length > 0) {
    warnings.push({
      code: "inert_knowledge",
      message:
        `knowledge declares ${knowledge.length} fact(s) (${knowledge.join(", ")}) but the ` +
        'strategy is "scripted", which never answers a question. The block has no effect ' +
        "until the strategy is open.",
    });
  }

  // The tenant's own text wins over their own policy rule, and an author who
  // wrote both probably did not realise they had.
  if (spec.policy.never.includes("quote_exact_fees")) {
    const quoting = Object.entries(spec.knowledge)
      .filter(([, text]) => FIGURE.test(text))
      .map(([key]) => key);
    if (quoting.length > 0) {
      warnings.push({
        code: "knowledge_contradicts_policy",
        message:
          `policy forbids quote_exact_fees, but knowledge.${quoting.join(", knowledge.")} ` +
          "contains a figure. Declared knowledge is sent as written and wins; the policy " +
          "rule still stops the agent putting a figure in its own framing.",
      });
    }
  }
  return warnings;
}

/**
 * A metric is a promise to a customer about what the invoice will say, so a
 * metric that can never be true is worse than a missing one: it reports zero
 * forever and looks like poor performance rather than a broken definition.
 */
function lintMetrics(spec: JourneySpec): SpecWarning[] {
  const warnings: SpecWarning[] = [];
  const targets = Object.values(spec.routing).map((r) => r.target);

  for (const [name, expr] of Object.entries(spec.metrics)) {
    let ast: MetricAst;
    try {
      ast = parseMetric(expr);
    } catch (err) {
      warnings.push({
        code: "unparseable_metric",
        message: `metric "${name}" cannot be parsed: ${(err as Error).message}`,
      });
      continue;
    }

    // `HandoffCreated` is only ever written by a routing target in the
    // `handoff.*` family, so a journey with no such target can never book.
    for (const type of eventTypesIn(ast)) {
      if (type === "HandoffCreated" && !targets.some((t) => t.startsWith("handoff."))) {
        warnings.push({
          code: "unreachable_metric",
          message:
            `metric "${name}" depends on HandoffCreated, but no routing rule targets ` +
            `a handoff (targets: ${targets.join(", ")}). It will always report zero.`,
        });
      }
    }
  }
  return warnings;
}

/**
 * A placeholder with no default and no runtime source reaches a lead as raw
 * braces. Catch it at authoring time, where it costs nothing to fix.
 */
function lintPinned(spec: JourneySpec): SpecWarning[] {
  const known = new Set([...RUNTIME_VARIABLES, ...Object.keys(pinnedDefaults(spec))]);
  const missing = new Map<string, string[]>();

  for (const [key, value] of Object.entries(spec.pinned)) {
    if (typeof value !== "string") continue;
    for (const m of value.matchAll(/\{\{\s*([\w.]+)\s*\}\}/g)) {
      const name = m[1]!;
      if (known.has(name)) continue;
      const where = missing.get(name) ?? [];
      where.push(key);
      missing.set(name, where);
    }
  }

  return [...missing.entries()].map(([name, keys]) => ({
    code: "unresolvable_template_variable" as const,
    message:
      `pinned.${keys.join(", pinned.")} uses {{${name}}}, which has no default under ` +
      `pinned.variables and is not supplied by the runtime. A lead would receive the ` +
      `raw placeholder.`,
  }));
}

function eventTypesIn(ast: MetricAst): string[] {
  return ast.kind === "and" || ast.kind === "or"
    ? [...eventTypesIn(ast.left), ...eventTypesIn(ast.right)]
    : [ast.type];
}

/** Extracts N from a `score >= N` atom, if the predicate contains one. */
function scoreThreshold(expr: string): number | null {
  const m = /score\s*>=\s*(-?\d+(?:\.\d+)?)/.exec(expr);
  return m ? Number(m[1]) : null;
}
