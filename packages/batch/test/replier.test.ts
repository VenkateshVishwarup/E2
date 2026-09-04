import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { ScriptedReplier } from "../src/simulate/replier.js";
import type { Persona } from "../src/simulate/persona.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));
const r = new ScriptedReplier();
const t = (role: "agent" | "lead", text: string): Turn => ({ role, text, at: new Date() });

const persona: Persona = {
  id: "p1",
  truth: { target_program: "executive_mba", timeline: "this_intake",
           budget_band: "above_15L", decision_maker: "self" },
  verbosity: "normal", cooperation: 1, objection: "none",
  dropoffAfterTurn: null, mood: "neutral",
};

describe("ScriptedReplier", () => {
  it("answers the field the agent asked about", async () => {
    const out = await r.reply(persona, spec, [t("agent", "Which programme are you considering?")]);
    expect(out).toContain("executive_mba");
  });

  it("matches a naturally-phrased question, not just the literal field name", async () => {
    // "budget_band" must match "budget range" - word-by-word, not as a phrase.
    const out = await r.reply(persona, spec, [t("agent", "What is your budget range?")]);
    expect(out).toContain("above_15L");
  });

  it("ghosts once past the dropoff turn", async () => {
    const ghost = { ...persona, dropoffAfterTurn: 1 };
    const turns = [t("agent", "hi"), t("lead", "hello"), t("agent", "which programme?")];
    expect(await r.reply(ghost, spec, turns)).toBeNull();
  });

  it("voices a frustrated mood when it cannot attribute the question", async () => {
    const cross = { ...persona, mood: "frustrated" as const, truth: {} };
    const out = await r.reply(cross, spec, [t("agent", "Hello there")]);
    expect(out).toMatch(/frustrating|waste/i);
  });

  it("deflects rather than answering when uncooperative", async () => {
    const cagey = { ...persona, cooperation: 0 };
    const out = await r.reply(cagey, spec, [t("agent", "What is your budget range?")]);
    expect(out).not.toContain("above_15L");
  });

  it("never leaks ground truth for a field that was not asked about", async () => {
    const out = await r.reply(persona, spec, [t("agent", "Which programme are you considering?")]);
    expect(out).not.toContain("above_15L");
  });

  it("still progresses when the question cannot be attributed", async () => {
    // A real lead who understands a question answers it. A double that stalls
    // would make every conversation look like a ghosting.
    const out = await r.reply(persona, spec, [t("agent", "Tell me a bit more?")]);
    expect(out).toContain("executive_mba");
  });

  it("moves to the next fact rather than repeating itself", async () => {
    const out = await r.reply(persona, spec, [
      t("agent", "Tell me a bit more?"),
      t("lead", "executive_mba"),
      t("agent", "And?"),
    ]);
    expect(out).toContain("this_intake");
  });
});
