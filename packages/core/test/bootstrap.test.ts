import { describe, it, expect } from "vitest";
import { bootstrapDiffCI, bootstrapUnpairedDiffCI, mulberry32 } from "../src/stats/bootstrap.js";

describe("mulberry32", () => {
  it("is deterministic for a given seed", () => {
    const a = mulberry32(42); const b = mulberry32(42);
    expect([a(), a(), a()]).toEqual([b(), b(), b()]);
  });
  it("stays inside [0, 1)", () => {
    const r = mulberry32(7);
    for (let i = 0; i < 500; i++) { const v = r(); expect(v).toBeGreaterThanOrEqual(0); expect(v).toBeLessThan(1); }
  });
});

describe("bootstrapDiffCI", () => {
  const rep = (trues: number, total: number) =>
    Array.from({ length: total }, (_, i) => i < trues);

  it("brackets a real difference without spanning zero", () => {
    const [lo, hi] = bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 1 });
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(0.2);
    expect(lo).toBeLessThan(hi);
  });

  it("spans zero when the two arms are identical", () => {
    const [lo, hi] = bootstrapDiffCI(rep(200, 1000), rep(200, 1000), { seed: 1 });
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(0);
  });

  it("is wider on a small sample than a large one", () => {
    const small = bootstrapDiffCI(rep(18, 100), rep(26, 100), { seed: 3 });
    const large = bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 3 });
    expect(small[1] - small[0]).toBeGreaterThan(large[1] - large[0]);
  });

  it("is reproducible for a fixed seed", () => {
    expect(bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 9 }))
      .toEqual(bootstrapDiffCI(rep(180, 1000), rep(260, 1000), { seed: 9 }));
  });

  it("refuses mismatched arms", () => {
    expect(() => bootstrapDiffCI(rep(1, 10), rep(1, 11))).toThrow(/same length/i);
  });
});

describe("bootstrapUnpairedDiffCI", () => {
  it("handles arms of different sizes, which the paired interval cannot", () => {
    const a = Array.from({ length: 40 }, (_, i) => i < 4);    // 10%
    const b = Array.from({ length: 90 }, (_, i) => i < 72);   // 80%
    expect(() => bootstrapDiffCI(a, b)).toThrow(/same length/);
    const [lo, hi] = bootstrapUnpairedDiffCI(a, b);
    expect(lo).toBeGreaterThan(0);
    expect(hi).toBeLessThan(1);
    expect(lo).toBeLessThan(0.7);
    expect(hi).toBeGreaterThan(0.7);
  });

  it("spans zero when the two cohorts are the same", () => {
    const a = Array.from({ length: 100 }, (_, i) => i % 2 === 0);
    const [lo, hi] = bootstrapUnpairedDiffCI(a, [...a]);
    expect(lo).toBeLessThanOrEqual(0);
    expect(hi).toBeGreaterThanOrEqual(0);
  });

  it("is deterministic for a given seed", () => {
    const a = Array.from({ length: 50 }, (_, i) => i < 20);
    const b = Array.from({ length: 70 }, (_, i) => i < 49);
    expect(bootstrapUnpairedDiffCI(a, b, { seed: 7 }))
      .toEqual(bootstrapUnpairedDiffCI(a, b, { seed: 7 }));
  });

  it("returns a degenerate interval rather than dividing by zero on an empty arm", () => {
    expect(bootstrapUnpairedDiffCI([], [true, false])).toEqual([0, 0]);
  });
});
