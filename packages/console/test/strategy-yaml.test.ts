import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec, isOpen, knowledgeKeys } from "@midfunnel/core/journey/spec";
import {
  ensureKnowledge, hasKnowledge, readStrategy, setStrategy, switchStrategy,
} from "../src/strategy-yaml.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../core/test/fixtures");
const SCRIPTED = readFileSync(join(FIXTURES, "mba-v4.yaml"), "utf8");
const OPEN = readFileSync(join(FIXTURES, "mba-v8-open.yaml"), "utf8");

describe("readStrategy", () => {
  it("reads a journey that declares no strategy as scripted", () => {
    expect(readStrategy(SCRIPTED)).toBe("scripted");
  });
  it("reads an open journey", () => {
    expect(readStrategy(OPEN)).toBe("open");
  });
  it("is not fooled by the word open appearing elsewhere", () => {
    expect(readStrategy(`${SCRIPTED}\n# we should try kind: open one day\n`)).toBe("scripted");
  });
});

describe("hasKnowledge", () => {
  it("is false when the block is absent", () => {
    expect(hasKnowledge(SCRIPTED)).toBe(false);
  });
  it("is false for an explicitly empty block, which declares nothing", () => {
    expect(hasKnowledge("journey: x\nknowledge: {}\npolicy:\n  never: []\n")).toBe(false);
  });
  it("is true when facts are declared", () => {
    expect(hasKnowledge(OPEN)).toBe(true);
  });
});

describe("setStrategy", () => {
  it("turns a scripted journey open, and it still parses", () => {
    const next = setStrategy(SCRIPTED, "open");
    const spec = parseSpec(next);
    expect(isOpen(spec)).toBe(true);
    expect(spec.strategy.moves).toContain("answer");
  });

  it("turns an open journey scripted, and it still parses", () => {
    const spec = parseSpec(setStrategy(OPEN, "scripted"));
    expect(isOpen(spec)).toBe(false);
  });

  it("is idempotent", () => {
    expect(setStrategy(setStrategy(SCRIPTED, "open"), "open"))
      .toBe(setStrategy(SCRIPTED, "open"));
  });

  it("round-trips back to something equivalent", () => {
    const there = setStrategy(SCRIPTED, "open");
    const back = parseSpec(setStrategy(there, "scripted"));
    expect(isOpen(back)).toBe(false);
    expect(back.evidence).toEqual(parseSpec(SCRIPTED).evidence);
  });

  it("leaves every other block, and its comments, untouched", () => {
    // The comments in this spec carry most of the reasoning. A structural
    // rewrite would throw them away.
    const next = setStrategy(SCRIPTED, "open");
    for (const marker of [
      "# ─── Who this journey runs as. Privileges are ENFORCED, not declared. ───",
      "# ─── The contract. THIS is the standardisation. ───",
      "sensitive: true          # never open with it; never ask twice",
      "# ─── Named metrics as predicates over events. No global \"converted\". ───",
    ]) {
      expect(next).toContain(marker);
    }
  });

  it("puts the block before policy, where it reads in order", () => {
    const next = setStrategy(SCRIPTED, "open");
    expect(next.indexOf("\nstrategy:")).toBeLessThan(next.indexOf("\npolicy:"));
    expect(next.indexOf("\nevidence:")).toBeLessThan(next.indexOf("\nstrategy:"));
  });

  it("does not disturb the comment that introduces the next block", () => {
    const next = setStrategy(OPEN, "scripted");
    expect(next).toContain("# ─── The agent chooses the path. It does not choose these. ───");
  });
});

describe("ensureKnowledge", () => {
  it("adds a starter block when there is none", () => {
    const next = ensureKnowledge(SCRIPTED);
    expect(knowledgeKeys(parseSpec(next))).toEqual(["example_topic"]);
  });
  it("leaves declared facts alone", () => {
    expect(ensureKnowledge(OPEN)).toBe(OPEN);
  });
  it("replaces an empty block rather than adding a second one", () => {
    const emptied = SCRIPTED.replace("\npolicy:", "\nknowledge: {}\n\npolicy:");
    const next = ensureKnowledge(emptied);
    expect(next.match(/^knowledge:/gm)).toHaveLength(1);
    expect(knowledgeKeys(parseSpec(next))).toEqual(["example_topic"]);
  });
});

describe("switchStrategy", () => {
  it("gives an open journey somewhere to put its facts", () => {
    // Otherwise the first thing the author sees is the unanswerable warning.
    const spec = parseSpec(switchStrategy(SCRIPTED, "open"));
    expect(isOpen(spec)).toBe(true);
    expect(knowledgeKeys(spec).length).toBeGreaterThan(0);
  });

  it("does not invent facts for a scripted journey", () => {
    expect(hasKnowledge(switchStrategy(SCRIPTED, "scripted"))).toBe(false);
  });

  it("keeps the journey publishable either way", () => {
    for (const kind of ["open", "scripted"] as const) {
      for (const source of [SCRIPTED, OPEN]) {
        expect(() => parseSpec(switchStrategy(source, kind))).not.toThrow();
      }
    }
  });
});
