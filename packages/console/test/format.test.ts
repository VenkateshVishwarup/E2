import { describe, it, expect } from "vitest";
import { spread } from "../src/format.js";

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

describe("spread", () => {
  it("shows a range across repeats as low–high", () => {
    expect(spread({ min: 0.03, max: 0.06 }, pct)).toBe("3.0%–6.0%");
  });

  it("collapses to one figure when the ends agree as displayed", () => {
    // 0.0301 and 0.0304 both read 3.0%; "3.0%–3.0%" would claim a spread the
    // screen cannot show.
    expect(spread({ min: 0.0301, max: 0.0304 }, pct)).toBe("3.0%");
  });
});
