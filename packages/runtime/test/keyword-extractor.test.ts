import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { KeywordExtractor } from "../src/keyword-extractor.js";
import { offlineClient } from "../src/offline-client.js";

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

describe("matching how people actually type", () => {
  const said = (text: string) =>
    new KeywordExtractor().extract(spec, [
      { role: "agent", text: "Which programme?", at: new Date() },
      { role: "lead", text, at: new Date() },
    ]);

  it("matches a value written as words rather than as an identifier", async () => {
    // The defect this guards: `executive_mba` never matched "executive MBA",
    // because the underscore is not in the sentence. The offline agent looked
    // broken to anyone who typed like a person.
    const got = await said("I'm looking at the Executive MBA, starting this intake.");
    expect(got.target_program).toMatchObject({ value: "executive_mba", confidence: 0.95 });
    expect(got.timeline).toMatchObject({ value: "this_intake" });
  });

  it("still matches the literal identifier", async () => {
    expect((await said("executive_mba")).target_program!.value).toBe("executive_mba");
  });

  it("prefers the more specific value when two could match", async () => {
    const got = await said("the full time MBA please");
    expect(got.target_program!.value).toBe("full_time_mba");
  });

  it("reports scattered words at lower confidence than a phrase", async () => {
    const scattered = await said("above what I said, around 15L");
    expect(scattered.budget_band).toMatchObject({ value: "above_15L", confidence: 0.8 });
    const phrase = await said("above 15L");
    expect(phrase.budget_band!.confidence).toBe(0.95);
  });

  it("ignores a value only the agent named", async () => {
    const got = await new KeywordExtractor().extract(spec, [
      { role: "agent", text: "Is it executive_mba or online_mba?", at: new Date() },
      { role: "lead", text: "not sure yet", at: new Date() },
    ]);
    expect(got.target_program).toBeUndefined();
  });

  it("does not match a word buried inside a longer one", async () => {
    const got = await said("I will decide it myself");
    expect(got.decision_maker).toBeUndefined();
  });
});

describe("offlineClient", () => {
  it("names the declared options, so a person is not guessing at a vocabulary", async () => {
    const client = offlineClient();
    const res = await client.responses.create({
      input: JSON.stringify({
        ask_about: { field: "target_program", type: "enum[executive_mba, online_mba]",
                     description: "Which programme are you actually considering" },
      }),
    } as never) as unknown as { output_text: string };
    expect(res.output_text).toBe(
      "Which programme are you actually considering? (executive mba, online mba)");
  });

  it("falls back to a plain question for a field with no options", async () => {
    const client = offlineClient();
    const res = await client.responses.create({
      input: JSON.stringify({ ask_about: { field: "prior_qualification", type: "string" } }),
    } as never) as unknown as { output_text: string };
    expect(res.output_text).toBe("Could you tell me your prior qualification?");
  });
});
