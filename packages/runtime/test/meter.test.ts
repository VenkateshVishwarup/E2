import { describe, it, expect } from "vitest";
import { CostMeter } from "../src/meter.js";
import { costOf, PRICES, MODELS } from "../src/provider.js";

describe("costOf", () => {
  it("bills cached input at the cached rate and reasoning as output", () => {
    const c = costOf(MODELS.sol, {
      input_tokens: 10_000,
      input_tokens_details: { cached_tokens: 8_000 },
      output_tokens: 4_000,
      output_tokens_details: { reasoning_tokens: 3_500 },
    });
    const p = PRICES[MODELS.sol]!;
    expect(c.usd).toBeCloseTo(2_000 * p.input + 8_000 * p.cachedInput + 4_000 * p.output, 9);
    expect(c.reasoningTokens).toBe(3_500);
    expect(c.priced).toBe(true);
  });

  it("confirms output dominates: reasoning effort is the cost lever, not caching", () => {
    // The measured shape of a real call — this is the arithmetic behind the
    // claim in the spec, kept as a test so it cannot drift into folklore.
    const usage = { input_tokens: 2_000, output_tokens: 4_000 };
    const uncached = costOf(MODELS.terra, usage).usd;
    const fullyCached = costOf(MODELS.terra, {
      ...usage, input_tokens_details: { cached_tokens: 2_000 },
    }).usd;
    expect(1 - fullyCached / uncached).toBeLessThan(0.1);
  });

  it("marks an unpriced model rather than silently costing it at zero", () => {
    const c = costOf("gpt-9-imaginary", { input_tokens: 1_000, output_tokens: 1_000 });
    expect(c.priced).toBe(false);
    expect(c.usd).toBe(0);
  });
});

describe("CostMeter", () => {
  it("accumulates across calls and resets on drain", () => {
    const m = new CostMeter();
    m.record(MODELS.terra, { input_tokens: 1_000, output_tokens: 1_000 });
    m.record(MODELS.luna, { input_tokens: 1_000, output_tokens: 1_000 });
    expect(m.callCount).toBe(2);
    expect(m.usd).toBeGreaterThan(0);

    const drained = m.drain();
    expect(drained.length).toBe(2);
    expect(m.callCount).toBe(0);
    expect(m.usd).toBe(0);
  });

  it("ignores a call that reported no usage rather than recording a zero", () => {
    const m = new CostMeter();
    m.record(MODELS.terra, undefined);
    expect(m.callCount).toBe(0);
  });
});
