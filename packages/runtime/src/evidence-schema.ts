import * as z from "zod/v4";
import { parseTypeExpr, type JourneySpec } from "@midfunnel/core/journey/spec";

/**
 * The Zod mirror of core's `evidenceToJsonSchema`, in the `zod/v4` dialect the
 * provider SDK helper requires. (Both OpenAI's `zodTextFormat` and Anthropic's
 * `zodOutputFormat` `require("zod/v4")` internally, so this file survived the
 * provider switch unchanged — worth keeping that way.)
 *
 * This lives in `runtime`, not `core`, on purpose: core must stay ignorant of
 * which model provider is behind `step()`. A different runtime brings its own
 * translation of the same evidence contract.
 *
 * Every field is present with a nullable value, so the model must say "not
 * established" explicitly rather than silently omitting a field.
 */
export function evidenceToZod(spec: JourneySpec) {
  const shape: Record<string, z.ZodType> = {};

  for (const [field, def] of Object.entries(spec.evidence)) {
    const t = parseTypeExpr(def.type);
    let value: z.ZodType;
    switch (t.kind) {
      case "enum":
        value = z.enum(t.values as [string, ...string[]]).nullable();
        break;
      case "string":
        value = (def.maxLength ? z.string().max(def.maxLength) : z.string()).nullable();
        break;
      case "number":  value = z.number().nullable(); break;
      case "boolean": value = z.boolean().nullable(); break;
    }
    shape[field] = z.object({
      value,
      confidence: z.number().min(0).max(1),
    }).describe(def.description ?? `Evidence field ${field}`);
  }

  return z.object(shape);
}
