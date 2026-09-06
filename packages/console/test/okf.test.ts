import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { OKF } from "../src/okf-content.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const OKF_DIR = join(ROOT, "okf");

/**
 * `okf-content.ts` is generated and committed, so the production build does not
 * have to regenerate it — regenerating made the build depend on `scripts/`,
 * which is not shipped, and the deploy failed on a missing module.
 *
 * The cost of committing generated output is drift. This is the guard: edit a
 * document without running `npm run okf:bundle` and the suite says so.
 */
describe("the bundled knowledge file matches the source", () => {
  const onDisk: Record<string, string> = {
    index: readFileSync(join(OKF_DIR, "index.md"), "utf8"),
  };
  for (const f of readdirSync(join(OKF_DIR, "concepts")).filter((n) => n.endsWith(".md"))) {
    onDisk[f.replace(/\.md$/, "")] = readFileSync(join(OKF_DIR, "concepts", f), "utf8");
  }

  it("bundles every document, and no extras", () => {
    expect(Object.keys(OKF).sort()).toEqual(Object.keys(onDisk).sort());
  });

  it("bundles them byte for byte", () => {
    for (const [name, text] of Object.entries(onDisk)) {
      expect(OKF[name], `${name} is stale — run \`npm run okf:bundle\``).toBe(text);
    }
  });

  it("links only to documents that exist", () => {
    for (const [name, text] of Object.entries(onDisk)) {
      for (const m of text.matchAll(/\]\(([^)]+\.md)\)/g)) {
        const key = m[1]!.replace(/^.*\//, "").replace(/\.md$/, "");
        expect(OKF[key], `${name} links to ${m[1]} which is not a document`).toBeDefined();
      }
    }
  });
});
