import { parse as parseYaml } from "yaml";
import { z } from "zod";

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
