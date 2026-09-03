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
  return { messages: { parse: vi.fn().mockResolvedValue({ parsed_output: parsed }) } };
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

  it("sends the journey spec as a cached system prefix", async () => {
    const client = fakeClient(EMPTY);
    await new EvidenceExtractor(client as never).extract(spec, turns);
    const req = client.messages.parse.mock.calls[0]![0] as {
      model: string;
      system: Array<{ cache_control?: unknown }>;
      output_config: { effort: string };
      thinking: unknown;
    };
    expect(req.model).toBe("claude-opus-5");
    expect(req.system[0]!.cache_control).toEqual({ type: "ephemeral" });
    expect(req.output_config.effort).toBe("low");
    expect(req.thinking).toEqual({ type: "adaptive" });
  });

  it("throws when the model returns no parsed output", async () => {
    await expect(new EvidenceExtractor(fakeClient(null) as never).extract(spec, turns))
      .rejects.toThrow(/structured output/i);
  });
});
