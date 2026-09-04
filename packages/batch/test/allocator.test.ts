import { describe, it, expect } from "vitest";
import { TrafficAllocator, type Allocation } from "../src/experiment/allocator.js";

const ab: Allocation = {
  source: "camp_1",
  arms: [{ target: "journey@4", weight: 50 }, { target: "journey@5", weight: 50 }],
};

const parallel: Allocation = {
  source: "landing_new",
  arms: [{ target: "journey@5", weight: 10 }, { target: "external:engati", weight: 90 }],
};

const keys = Array.from({ length: 4000 }, (_, i) => `lead_${i}`);

describe("TrafficAllocator", () => {
  it("is deterministic for a key", () => {
    const a = new TrafficAllocator([ab]);
    expect(a.allocate("camp_1", "lead_7")).toBe(a.allocate("camp_1", "lead_7"));
  });

  it("respects an even split within tolerance", () => {
    const a = new TrafficAllocator([ab]);
    const counts = keys.reduce<Record<string, number>>((acc, k) => {
      const t = a.allocate("camp_1", k);
      acc[t] = (acc[t] ?? 0) + 1;
      return acc;
    }, {});
    expect(counts["journey@4"]! / keys.length).toBeGreaterThan(0.45);
    expect(counts["journey@4"]! / keys.length).toBeLessThan(0.55);
  });

  it("respects an uneven split, which is what a parallel run looks like", () => {
    const a = new TrafficAllocator([parallel]);
    const canary = keys.filter((k) => a.allocate("landing_new", k) === "journey@5").length;
    expect(canary / keys.length).toBeGreaterThan(0.06);
    expect(canary / keys.length).toBeLessThan(0.14);
  });

  it("does not correlate arms across experiments", () => {
    // A lead unlucky in one experiment must not be unlucky in all of them.
    const a = new TrafficAllocator([ab, { ...ab, source: "camp_2" }]);
    const differ = keys.filter((k) =>
      a.allocate("camp_1", k) !== a.allocate("camp_2", k)).length;
    expect(differ / keys.length).toBeGreaterThan(0.3);
  });

  it("throws for an unconfigured source", () => {
    expect(() => new TrafficAllocator([ab]).allocate("nope", "k")).toThrow(/no allocation/i);
  });

  it("rejects arms whose weights do not sum to 100", () => {
    expect(() => new TrafficAllocator([{ source: "s", arms: [{ target: "x", weight: 30 }] }]))
      .toThrow(/sum to 100/i);
  });

  it("splits a whole cohort into arms", () => {
    const groups = new TrafficAllocator([ab]).split("camp_1", keys);
    expect(Object.keys(groups).sort()).toEqual(["journey@4", "journey@5"]);
    expect(groups["journey@4"]!.length + groups["journey@5"]!.length).toBe(keys.length);
  });
});
