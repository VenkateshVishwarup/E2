import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { parseMetric, type MetricAst } from "../metrics/predicate.js";

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
  pinned: z.record(z.string()).default({}),
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

  return { ...parsed, agent: { ...parsed.agent, dataScope: parsed.agent.data_scope } };
}

export function requiredEvidenceFields(spec: JourneySpec): string[] {
  return Object.entries(spec.evidence).filter(([, d]) => d.required).map(([f]) => f);
}

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
    | "unreachable_metric";
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
