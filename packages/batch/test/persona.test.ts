import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, parseTypeExpr } from "@midfunnel/core/journey/spec";
import { generatePersonas } from "../src/simulate/persona.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

describe("generatePersonas", () => {
  it("is deterministic for a given seed", () => {
    expect(generatePersonas(spec, 20, 7)).toEqual(generatePersonas(spec, 20, 7));
  });

  it("differs across seeds", () => {
    expect(generatePersonas(spec, 20, 1)).not.toEqual(generatePersonas(spec, 20, 2));
  });

  it("gives every persona a ground truth drawn from the declared enums", () => {
    for (const p of generatePersonas(spec, 30, 3)) {
      for (const [field, value] of Object.entries(p.truth)) {
        const t = parseTypeExpr(spec.evidence[field]!.type);
        expect(t.kind).toBe("enum");
        if (t.kind === "enum") expect(t.values).toContain(value);
      }
    }
  });

  it("always establishes truth for every required field", () => {
    const required = Object.entries(spec.evidence)
      .filter(([, d]) => d.required).map(([f]) => f);
    for (const p of generatePersonas(spec, 30, 4)) {
      for (const f of required) expect(p.truth[f]).toBeDefined();
    }
  });

  it("produces a spread of behaviours rather than one archetype", () => {
    const ps = generatePersonas(spec, 200, 5);
    expect(new Set(ps.map((p) => p.verbosity)).size).toBeGreaterThan(1);
    expect(new Set(ps.map((p) => p.objection)).size).toBeGreaterThan(2);
    expect(new Set(ps.map((p) => p.mood)).size).toBeGreaterThan(1);
    expect(ps.some((p) => p.dropoffAfterTurn !== null)).toBe(true);
    expect(ps.some((p) => p.dropoffAfterTurn === null)).toBe(true);
  });

  it("gives every persona a unique id", () => {
    const ps = generatePersonas(spec, 100, 6);
    expect(new Set(ps.map((p) => p.id)).size).toBe(100);
  });

  it("never seeds truth for a free-text field, which cannot be graded", () => {
    for (const p of generatePersonas(spec, 40, 8)) {
      expect(p.truth).not.toHaveProperty("prior_qualification");
    }
  });
});
