import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { EvidenceExtractor } from "../src/extractor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

const turns: Turn[] = [
  { role: "agent", text: "Hi Ravi, which programme are you considering?", at: new Date() },
  { role: "lead", text: "the executive mba, want to start this intake", at: new Date() },
];

const EMPTY = {
  target_program: { value: null, confidence: 0 },
  timeline: { value: null, confidence: 0 },
  budget_band: { value: null, confidence: 0 },
  decision_maker: { value: null, confidence: 0 },
  prior_qualification: { value: null, confidence: 0 },
};

function fakeClient(parsed: unknown) {
  return { responses: { parse: vi.fn().mockResolvedValue({ output_parsed: parsed }) } };
}

describe("EvidenceExtractor", () => {
  it("keeps fields at or above their confidence floor", async () => {
    const client = fakeClient({
      ...EMPTY,
      target_program: { value: "executive_mba", confidence: 0.93 },
      timeline: { value: "this_intake", confidence: 0.88 },
    });
    const out = await new EvidenceExtractor(client as never).extract(spec, turns);
    expect(out).toEqual({
      target_program: { value: "executive_mba", confidence: 0.93 },
      timeline: { value: "this_intake", confidence: 0.88 },
    });
  });

  it("drops a field below its declared confidence_min", async () => {
    // target_program requires 0.8; 0.55 is not good enough to record as fact.
    const client = fakeClient({ ...EMPTY, target_program: { value: "online_mba", confidence: 0.55 } });
    const out = await new EvidenceExtractor(client as never).extract(spec, turns);
    expect(out).not.toHaveProperty("target_program");
  });

  it("puts the journey spec in the stable prefix with a per-version cache key", async () => {
    const client = fakeClient(EMPTY);
    await new EvidenceExtractor(client as never).extract(spec, turns);
    const req = client.responses.parse.mock.calls[0]![0] as {
      model: string;
      instructions: string;
      prompt_cache_key: string;
      reasoning: { effort: string };
      input: string;
    };
    // dev profile is the default while building.
    expect(req.model).toBe("gpt-5.6-terra");
    expect(req.reasoning.effort).toBe("low");
    // Prefix caching is automatic and prefix-matched, so the spec must sit in
    // `instructions` and the volatile transcript only in `input`.
    expect(req.instructions).toContain(spec.journey);
    expect(req.instructions).not.toContain("TRANSCRIPT");
    expect(req.input).toContain("TRANSCRIPT");
    expect(req.prompt_cache_key).toBe(`${spec.journey}@${spec.version}`);
  });

  it("does not reuse a cache key across journey versions", async () => {
    const client = fakeClient(EMPTY);
    const x = new EvidenceExtractor(client as never);
    await x.extract(spec, turns);
    await x.extract({ ...spec, version: 99 }, turns);
    const keys = client.responses.parse.mock.calls.map((c) => (c[0] as { prompt_cache_key: string }).prompt_cache_key);
    expect(new Set(keys).size).toBe(2);
  });

  it("throws when the model returns no parsed output", async () => {
    await expect(new EvidenceExtractor(fakeClient(null) as never).extract(spec, turns))
      .rejects.toThrow(/structured output/i);
  });
});
