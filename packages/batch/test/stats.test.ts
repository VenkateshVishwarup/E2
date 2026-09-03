import { describe, it, expect } from "vitest";
import { bootstrapDiffCI, mulberry32 } from "../src/replay/stats.js";

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
