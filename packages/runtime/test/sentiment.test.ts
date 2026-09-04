import { describe, it, expect } from "vitest";
import type { Turn } from "@midfunnel/core/events/types";
import { LexiconSentiment } from "../src/sentiment.js";

const t = (role: "agent" | "lead", text: string): Turn => ({ role, text, at: new Date() });
const s = new LexiconSentiment();

describe("LexiconSentiment", () => {
  it("scores a frustrated lead negative", () => {
    const r = s.analyze([t("lead", "this is useless, terrible service, waste of my time")]);
    expect(r.score).toBeLessThan(-0.5);
    expect(r.reason).toMatch(/negative/i);
  });

  it("scores an enthusiastic lead positive", () => {
    expect(s.analyze([t("lead", "great, perfect, this sounds excellent")]).score)
      .toBeGreaterThan(0.3);
  });

  it("scores neutral text near zero", () => {
    expect(Math.abs(s.analyze([t("lead", "executive mba, this intake")]).score))
      .toBeLessThan(0.2);
  });

  it("ignores what the AGENT said", () => {
    expect(s.analyze([t("agent", "sorry, terrible, my apologies")]).score).toBe(0);
  });

  it("weights the most recent lead turn most heavily", () => {
    const recovered = s.analyze([
      t("lead", "this is terrible and useless"),
      t("lead", "actually that is perfect, great, excellent, wonderful"),
    ]);
    const stillAngry = s.analyze([
      t("lead", "that is perfect and great"),
      t("lead", "no this is terrible, useless, awful, horrible"),
    ]);
    expect(recovered.score).toBeGreaterThan(stillAngry.score);
  });

  it("returns zero for no lead turns", () => {
    expect(s.analyze([]).score).toBe(0);
  });
});
