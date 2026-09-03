import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { KeywordExtractor } from "../src/keyword-extractor.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const x = new KeywordExtractor();

const t = (role: "agent" | "lead", text: string): Turn => ({ role, text, at: new Date() });

describe("KeywordExtractor", () => {
  it("extracts enum values stated by the lead", async () => {
    const out = await x.extract(spec, [
      t("agent", "Which programme?"),
      t("lead", "executive_mba, this_intake, budget above_15L, decided by self"),
    ]);
    expect(out.target_program?.value).toBe("executive_mba");
    expect(out.timeline?.value).toBe("this_intake");
    expect(out.budget_band?.value).toBe("above_15L");
    expect(out.decision_maker?.value).toBe("self");
  });

  it("ignores values that only the AGENT said", async () => {
    // The agent naming an option must never become established evidence.
    const out = await x.extract(spec, [
      t("agent", "Are you looking at executive_mba or online_mba?"),
      t("lead", "not sure yet"),
    ]);
    expect(out).not.toHaveProperty("target_program");
  });

  it("returns nothing when the lead states nothing recognisable", async () => {
    expect(await x.extract(spec, [t("lead", "hello there")])).toEqual({});
  });

  it("prefers the most recent statement when the lead changes their mind", async () => {
    const out = await x.extract(spec, [
      t("lead", "online_mba please"),
      t("lead", "actually executive_mba"),
    ]);
    expect(out.target_program?.value).toBe("executive_mba");
  });
});
