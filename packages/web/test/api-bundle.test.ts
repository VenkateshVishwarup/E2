import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * `api/index.js` is a committed build artifact — see `server/README.md` for why
 * it cannot be generated during the deploy.
 *
 * The cost of committing one is that it goes stale silently, and stale here
 * means the deployed API is not the code in the repository. This rebuilds it
 * and compares.
 */
describe("the deployed function matches its source", () => {
  it("is up to date with server/api-handler.ts", () => {
    const out = mkdtempSync(join(tmpdir(), "api-bundle-"));
    try {
      // The real command, read from package.json with the output redirected.
      // Restating the flags here meant they drifted the first time one changed,
      // and the test then failed for its own reason rather than a real one.
      const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as
        { scripts: Record<string, string> };
      const command = pkg.scripts["build:api"]!
        .replace("--outfile=api/index.js", `--outfile=${join(out, "index.js")}`);
      // Through the shell with the workspace's binaries on PATH, so the
      // command runs exactly as `npm run build:api` would.
      execFileSync("sh", ["-c", command], {
        cwd: ROOT, stdio: "pipe",
        env: { ...process.env, PATH: `${join(ROOT, "node_modules/.bin")}:${process.env.PATH}` },
      });

      const fresh = readFileSync(join(out, "index.js"), "utf8");
      const committed = readFileSync(join(ROOT, "api/index.js"), "utf8");
      expect(committed.length, "run `npm run build:api`").toBe(fresh.length);
      expect(committed === fresh, "api/index.js is stale — run `npm run build:api`").toBe(true);
    } finally {
      rmSync(out, { recursive: true, force: true });
    }
  }, 60_000);

  it("actually loads under Node", async () => {
    // Two deploys died on things a byte-comparison cannot see: workspace
    // imports left external, then `pg` calling require() inside an ESM bundle
    // ("Dynamic require of events is not supported"). Both surface the instant
    // the module is evaluated, so evaluate it.
    const mod = await import(join(ROOT, "api/index.js"));
    expect(typeof mod.default).toBe("function");
  }, 30_000);

  it("inlines the workspace packages rather than importing them", () => {
    // The failure this guards: Vercel leaves `@midfunnel/*` external and
    // resolves them to TypeScript source that is not in the lambda.
    const bundle = readFileSync(join(ROOT, "api/index.js"), "utf8");
    const externals = [...bundle.matchAll(/^import .* from "(@midfunnel\/[^"]+)"/gm)];
    expect(externals.map((m) => m[1])).toEqual([]);
  });
});
