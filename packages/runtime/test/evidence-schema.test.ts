import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, evidenceToJsonSchema } from "@midfunnel/core/journey/spec";
import { evidenceToZod } from "../src/evidence-schema.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const yaml = readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8");
const spec = parseSpec(yaml);

const EMPTY = {
  target_program: { value: null, confidence: 0 },
  timeline: { value: null, confidence: 0 },
  budget_band: { value: null, confidence: 0 },
  decision_maker: { value: null, confidence: 0 },
  prior_qualification: { value: null, confidence: 0 },
};

describe("evidenceToZod", () => {
  it("mirrors core's JSON Schema contract exactly", () => {
    const shape = evidenceToZod(spec).shape as Record<string, unknown>;
    const js = evidenceToJsonSchema(spec) as { required: string[] };
    // One contract, two renderings — they must never drift.
    expect(Object.keys(shape).sort()).toEqual([...js.required].sort());
  });

  it("accepts a null value for an unestablished field", () => {
    const parsed = evidenceToZod(spec).parse({
      ...EMPTY, target_program: { value: "executive_mba", confidence: 0.9 },
    }) as typeof EMPTY;
    expect(parsed.timeline.value).toBeNull();
  });

  it("rejects a value outside the declared enum", () => {
    expect(() => evidenceToZod(spec).parse({
      ...EMPTY, target_program: { value: "phd", confidence: 0.9 },
    })).toThrow();
  });

  it("enforces the declared maxLength on a string field", () => {
    expect(() => evidenceToZod(spec).parse({
      ...EMPTY, prior_qualification: { value: "x".repeat(200), confidence: 0.9 },
    })).toThrow();
  });
});
