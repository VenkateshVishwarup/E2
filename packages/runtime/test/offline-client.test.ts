import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import { AgentRuntime } from "../src/step.js";
import { KeywordExtractor } from "../src/keyword-extractor.js";
import { offlineClient } from "../src/offline-client.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const spec = parseSpec(readFileSync(join(HERE, "../../core/test/fixtures/mba-v4.yaml"), "utf8"));

describe("offlineClient", () => {
  it("lets the runtime ask a follow-up with no provider at all", async () => {
    // Regression: the offline runtime was built with {} as its client, which
    // crashed on any conversation reaching a second turn. Replay never asks,
    // so only simulation hit it.
    const state: LeadState = {
      leadId: "sim_1", journey: spec.journey, journeyVersion: 4,
      evidence: {}, outcomes: [],
      turns: [
        { role: "agent", text: "Hi", at: new Date() },
        { role: "lead", text: "executive_mba", at: new Date() },
      ],
    };
    const rt = new AgentRuntime(new KeywordExtractor() as never, offlineClient());
    const actions = await rt.step(spec, state, { allowFollowUp: true });

    const send = actions.find((a) => a.kind === "send");
    expect(send).toBeDefined();
    expect((send as { text: string }).text).toMatch(/tell me your/i);
  });

  it("names the field the runtime asked about", async () => {
    const r = await offlineClient().responses.create({
      input: JSON.stringify({ ask_about: { field: "budget_band" } }),
    } as never);
    expect((r as unknown as { output_text: string }).output_text).toContain("budget band");
  });

  it("degrades to a generic question on unparseable input", async () => {
    const r = await offlineClient().responses.create({ input: "not json" } as never);
    expect((r as unknown as { output_text: string }).output_text).toMatch(/tell me your that/i);
  });
});
