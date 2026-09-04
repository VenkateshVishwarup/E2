import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { credentialFingerprint, loadEnvFile } from "../src/provider.js";

let dir: string;
const saved = process.env.OPENAI_API_KEY;

beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "mf-")); });
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (saved === undefined) delete process.env.OPENAI_API_KEY;
  else process.env.OPENAI_API_KEY = saved;
  delete process.env.MF_PROBE;
});

describe("loadEnvFile", () => {
  it("overrides a variable already set in the environment", () => {
    // Regression: a stale credential inherited from a GUI app silently shadowed
    // a deliberately created project .env, and nothing said so.
    process.env.OPENAI_API_KEY = "sk-stale-PkYA";
    const f = join(dir, ".env");
    writeFileSync(f, "OPENAI_API_KEY=sk-real-riwA\n");

    expect(loadEnvFile(f)).toContain("OPENAI_API_KEY");
    expect(process.env.OPENAI_API_KEY).toBe("sk-real-riwA");
  });

  it("reports which source the credential came from", () => {
    process.env.OPENAI_API_KEY = "sk-stale-PkYA";
    // A .env that does not mention the key leaves the ambient one in place.
    const empty = join(dir, "empty.env");
    writeFileSync(empty, "# nothing here\n");
    loadEnvFile(empty);
    expect(credentialFingerprint()).toContain("inherited environment");

    const f = join(dir, ".env");
    writeFileSync(f, "OPENAI_API_KEY=sk-real-riwA\n");
    loadEnvFile(f);
    expect(credentialFingerprint()).toContain("from .env");
    expect(credentialFingerprint()).toContain("ending riwA");
  });

  it("never reveals the key itself", () => {
    process.env.OPENAI_API_KEY = "sk-proj-supersecretvalue-abcd";
    const fp = credentialFingerprint();
    expect(fp).not.toContain("supersecret");
    expect(fp).toContain("ending abcd");
  });

  it("reports none when no credential is present", () => {
    delete process.env.OPENAI_API_KEY;
    expect(credentialFingerprint()).toBe("none");
  });

  it("skips comments and blank lines, and strips quotes", () => {
    const f = join(dir, ".env");
    writeFileSync(f, '# a comment\n\nMF_PROBE="quoted value"\n');
    loadEnvFile(f);
    expect(process.env.MF_PROBE).toBe("quoted value");
  });

  it("is a no-op when there is no .env", () => {
    expect(loadEnvFile(join(dir, "absent.env"))).toEqual([]);
  });

  it("does not report a stale source after a later load", () => {
    process.env.OPENAI_API_KEY = "sk-a-riwA";
    const withKey = join(dir, "a.env");
    writeFileSync(withKey, "OPENAI_API_KEY=sk-a-riwA\n");
    loadEnvFile(withKey);
    expect(credentialFingerprint()).toContain("from .env");

    const without = join(dir, "b.env");
    writeFileSync(without, "MF_PROBE=x\n");
    loadEnvFile(without);
    expect(credentialFingerprint()).toContain("inherited environment");
  });
});
