import { describe, it, expect } from "vitest";
import {
  CHANNELS, CHANNEL_TRAITS, consented, isChannel, renderForChannel,
} from "../src/channels.js";

describe("isChannel", () => {
  it("accepts the declared channels and nothing else", () => {
    for (const c of CHANNELS) expect(isChannel(c)).toBe(true);
    for (const c of ["sms", "", "WEB", null, 7]) expect(isChannel(c)).toBe(false);
  });
});

describe("renderForChannel — web", () => {
  it("passes the agent's own wording through", () => {
    const q = "Could you tell me your timeline? (this intake, next intake, just exploring)";
    expect(renderForChannel(q, "web")).toEqual({ text: q, truncated: false });
  });
});

describe("renderForChannel — voice", () => {
  const spoken = (t: string) => renderForChannel(t, "voice").text;

  it("turns a parenthetical list into one a person can say", () => {
    // A speech engine reads the bracket aloud, and a caller hears a list with
    // no grammar.
    expect(spoken("Which intake? (this intake, next intake, just exploring)"))
      .toBe("Which intake? — this intake, next intake or just exploring");
  });

  it("handles a single parenthetical without inventing a list", () => {
    expect(spoken("Our fee (per year) varies.")).toBe("Our fee — per year varies.");
  });

  it("reads a slash as a word", () => {
    expect(spoken("Is that self / employer funded?")).toBe("Is that self or employer funded?");
  });

  it("does not leave an underscore in the middle of a word", () => {
    expect(spoken("Is it executive_mba?")).toBe("Is it executive mba?");
  });

  it("leaves ordinary prose alone", () => {
    expect(spoken("Happy to explain. There are merit scholarships."))
      .toBe("Happy to explain. There are merit scholarships.");
  });
});

describe("renderForChannel — length", () => {
  it("has no practical limit on the web", () => {
    expect(renderForChannel("x".repeat(5000), "web").truncated).toBe(false);
  });

  it("trims to a sentence end where there is one near the limit", () => {
    const limit = CHANNEL_TRAITS.whatsapp.maxLength!;
    const text = `${"a".repeat(limit - 20)}. ${"b".repeat(200)}`;
    const out = renderForChannel(text, "whatsapp");
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith(".")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(limit);
  });

  it("marks an unavoidable cut rather than hiding it", () => {
    const out = renderForChannel("c".repeat(2000), "voice");
    expect(out.truncated).toBe(true);
    expect(out.text.endsWith("…")).toBe(true);
    expect(out.text.length).toBeLessThanOrEqual(CHANNEL_TRAITS.voice.maxLength!);
  });
});

describe("consented", () => {
  it("is an allow-list", () => {
    expect(consented(["whatsapp"], "whatsapp")).toBe(true);
    expect(consented(["whatsapp"], "voice")).toBe(false);
  });

  it("reaches nobody when empty", () => {
    // Absence is refusal, not "not specified": consent is the one thing a
    // channel rollout cannot fix with an apology.
    for (const c of CHANNELS) expect(consented([], c)).toBe(false);
  });
});
