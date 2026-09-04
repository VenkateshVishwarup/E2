import { describe, it, expect } from "vitest";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  evidenceBottleneck, segmentDivergence, dropOff, routingMiscalibration,
  timing, policyFriction, versionRegression, type DetectorContext,
} from "../src/insights/detectors.js";
import { MIN_SUPPORT } from "../src/insights/types.js";
import type { LeadView } from "../src/insights/view.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const SPEC = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const CTX: DetectorContext = { specs: new Map([[4, SPEC]]), tz: "Asia/Kolkata" };

function view(over: Partial<LeadView> = {}): LeadView {
  return {
    leadId: `L${Math.random()}`, journeyVersion: 4, campaignId: "camp_0", creativeId: "cr_0",
    evidence: {}, missingRequired: [], turns: [], leadReplies: 1,
    score: 50, decision: "warm", completed: true, qualified: false, converted: false,
    policyFired: [], firstContactAt: new Date("2026-06-01T04:30:00Z"), repliedAfterPolicy: null,
    ...over,
  };
}

const many = (n: number, f: (i: number) => Partial<LeadView>) =>
  Array.from({ length: n }, (_, i) => view(f(i)));

describe("evidenceBottleneck", () => {
  it("names the least-collected field and the conversion gap it costs", () => {
    const views = [
      // 60 leads have budget_band and mostly convert
      ...many(60, (i) => ({ evidence: { timeline: "this_intake", budget_band: "above_15L" }, converted: i < 42 })),
      // 90 do not, and mostly do not
      ...many(90, (i) => ({ evidence: { timeline: "this_intake" }, converted: i < 18 })),
    ];
    const { findings } = evidenceBottleneck(views, CTX);
    const f = findings.find((x) => x.claim.includes("budget_band"));
    expect(f).toBeDefined();
    expect(f!.claim).toMatch(/collected in only 40.0%/);
    expect(f!.ci95![0]).toBeGreaterThan(0);
    expect(f!.suggestion).toMatch(/confidence_min/);
  });

  it("stays silent when the gap is inside the confidence interval", () => {
    const views = [
      ...many(60, (i) => ({ evidence: { budget_band: "above_15L" }, converted: i % 2 === 0 })),
      ...many(60, (i) => ({ evidence: {}, converted: i % 2 === 0 })),
    ];
    expect(evidenceBottleneck(views, CTX).findings).toEqual([]);
  });

  it("reports nothing rather than dividing by zero when no evidence was extracted", () => {
    const { findings, skipped } = evidenceBottleneck(many(50, () => ({})), CTX);
    expect(findings).toEqual([]);
    expect(skipped).toMatch(/no EvidenceExtracted/);
  });
});

describe("segmentDivergence", () => {
  it("finds a cohort that converts worse and suggests branching on it", () => {
    const views = [
      ...many(60, (i) => ({ campaignId: "camp_bad", converted: i < 6 })),
      ...many(90, (i) => ({ campaignId: "camp_good", converted: i < 54 })),
    ];
    const f = segmentDivergence(views, CTX).findings.find((x) => x.claim.includes("camp_bad"));
    expect(f).toBeDefined();
    expect(f!.claim).toMatch(/worse/);
    expect(f!.severity).toBe("high");
    expect(f!.ci95![1]).toBeLessThan(0);
    expect(f!.suggestion).toMatch(/Branch on/);
  });

  it("suppresses a cohort below minimum support however dramatic it looks", () => {
    const views = [
      // 10 leads, all converting: a 100% vs 10% gap that means nothing.
      ...many(MIN_SUPPORT - 20, () => ({ campaignId: "tiny", converted: true })),
      ...many(120, (i) => ({ campaignId: "camp_0", converted: i < 12 })),
    ];
    expect(segmentDivergence(views, CTX).findings.some((f) => f.claim.includes("tiny"))).toBe(false);
  });
});

describe("dropOff", () => {
  it("locates where abandonment concentrates and reads the opener when it is turn zero", () => {
    const views = [
      ...many(50, () => ({ completed: false, leadReplies: 0, turns: [{ role: "agent" as const, text: "hi", at: new Date() }] })),
      ...many(10, () => ({ completed: false, leadReplies: 3, turns: [{ role: "agent" as const, text: "hi", at: new Date() }] })),
      ...many(40, () => ({ completed: true })),
    ];
    const [f] = dropOff(views, CTX).findings;
    expect(f!.claim).toMatch(/after 0 lead replies/);
    expect(f!.severity).toBe("high");
    expect(f!.suggestion).toMatch(/opener is not earning a reply/);
  });

  it("declines to guess from a handful of unfinished conversations", () => {
    const { findings, skipped } = dropOff(many(5, () => ({ completed: false, turns: [{ role: "agent" as const, text: "hi", at: new Date() }] })), CTX);
    expect(findings).toEqual([]);
    expect(skipped).toMatch(/need 30/);
  });
});

describe("routingMiscalibration", () => {
  it("surfaces converters that routing sent away, with example leads to drill into", () => {
    const views = [
      ...many(40, (i) => ({ decision: "hot", converted: i < 32 })),
      ...many(60, (i) => ({ decision: "cold", converted: i < 12, leadId: `cold-${i}` })),
    ];
    const [f] = routingMiscalibration(views, CTX).findings;
    expect(f!.claim).toMatch(/12 leads routed away from handoff converted anyway/);
    expect((f!.evidence.exampleLeads as string[]).length).toBe(5);
  });

  it("says the score carries no signal when hot and cold are indistinguishable", () => {
    const views = [
      ...many(60, (i) => ({ decision: "hot", converted: i % 2 === 0 })),
      ...many(60, (i) => ({ decision: "cold", converted: i % 2 === 0 })),
    ];
    const [f] = routingMiscalibration(views, CTX).findings;
    expect(f!.claim).toMatch(/not separating converters/);
    expect(f!.suggestion).toMatch(/Re-weight/);
  });
});

describe("timing", () => {
  it("compares reply rates by time of day in the journey's own timezone", () => {
    // 04:30 UTC is 10:00 in Asia/Kolkata (morning); 16:30 UTC is 22:00 (evening).
    const views = [
      ...many(60, (i) => ({ firstContactAt: new Date("2026-06-01T04:30:00Z"), leadReplies: i < 48 ? 1 : 0 })),
      ...many(60, (i) => ({ firstContactAt: new Date("2026-06-01T16:30:00Z"), leadReplies: i < 12 ? 1 : 0 })),
    ];
    const [f] = timing(views, CTX).findings;
    expect(f!.claim).toMatch(/morning/);
    expect(f!.claim).toMatch(/evening/);
    expect(f!.detail).toMatch(/Asia\/Kolkata/);
  });

  it("stays quiet when only one time of day has enough leads", () => {
    const views = many(80, () => ({ firstContactAt: new Date("2026-06-01T04:30:00Z") }));
    expect(timing(views, CTX).skipped).toMatch(/fewer than two times of day/);
  });
});

describe("policyFriction", () => {
  it("connects a firing rule to conversations that then went silent", () => {
    const views = [
      ...many(50, (i) => ({
        policyFired: ["evidence.budget_band == needs_financing"],
        repliedAfterPolicy: false, converted: i < 5,
      })),
      ...many(80, (i) => ({ converted: i < 40 })),
    ];
    const [f] = policyFriction(views, CTX).findings;
    expect(f!.claim).toMatch(/needs_financing/);
    expect(f!.claim).toMatch(/100.0% of them/);
    // The fired cohort converts worse, and the wording must say so.
    expect(f!.detail).toMatch(/worse/);
    expect(f!.suggestion).toMatch(/branch in the journey/);
  });

  it("reports that it had nothing to read rather than implying a clean bill", () => {
    expect(policyFriction(many(80, () => ({})), CTX).skipped).toMatch(/no PolicyEvaluated events/);
  });
});

describe("versionRegression", () => {
  it("flags only a regression, never an improvement", () => {
    const worse = [
      ...many(60, (i) => ({ journeyVersion: 3, converted: i < 42 })),
      ...many(60, (i) => ({ journeyVersion: 4, converted: i < 12 })),
    ];
    const [f] = versionRegression(worse, CTX).findings;
    expect(f!.claim).toMatch(/v4 converts .* worse than v3/);

    const better = worse.map((v) => ({ ...v, converted: v.journeyVersion === 4 ? true : v.converted }));
    expect(versionRegression(better, CTX).findings).toEqual([]);
  });

  it("needs two versions to compare", () => {
    expect(versionRegression(many(80, () => ({})), CTX).skipped).toMatch(/only one journey version/);
  });
});
