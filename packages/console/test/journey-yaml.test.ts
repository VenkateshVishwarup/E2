import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { asNewJourney, journeyNameProblem } from "../src/journey-yaml.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURES = join(HERE, "../../core/test/fixtures");
const SCRIPTED = readFileSync(join(FIXTURES, "mba-v4.yaml"), "utf8");
const OPEN = readFileSync(join(FIXTURES, "mba-v8-open.yaml"), "utf8");

describe("asNewJourney", () => {
  it("renames the journey and starts it at version 1", () => {
    const spec = parseSpec(asNewJourney(OPEN, "pgdm-admissions"));
    expect(spec.journey).toBe("pgdm-admissions");
    expect(spec.version).toBe(1);
  });

  it("keeps everything else the author wrote, comments included", () => {
    const before = OPEN.split("\n");
    const after = asNewJourney(OPEN, "pgdm-admissions").split("\n");
    expect(after).toHaveLength(before.length);
    const changed = after.filter((line, i) => line !== before[i]);
    expect(changed).toEqual(["journey: pgdm-admissions", "version: 1"]);
  });

  it("touches only the top-level keys, never a nested one with the same name", () => {
    const nested = `${SCRIPTED}\nmetrics_note:\n  journey: keep-me\n  version: 9\n`;
    const out = asNewJourney(nested, "pgdm-admissions");
    expect(out).toContain("  journey: keep-me");
    expect(out).toContain("  version: 9");
  });
});

describe("journeyNameProblem", () => {
  it("accepts a name a URL can carry", () => {
    expect(journeyNameProblem("pgdm-2027", [])).toBeNull();
  });

  it("explains a name the server would refuse, before anyone presses publish", () => {
    for (const bad of ["", "PGDM", "pgdm admissions", "pgdm_admissions", "-pgdm", "a".repeat(121)]) {
      expect(journeyNameProblem(bad, []), JSON.stringify(bad)).toMatch(/.+/);
    }
  });

  it("refuses a name that already exists, since that would be a version, not a journey", () => {
    expect(journeyNameProblem("mba-admissions-qualification", ["mba-admissions-qualification"]))
      .toMatch(/already exists/);
  });
});
