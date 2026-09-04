import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, rmSync, mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { activeProfile, credentialFingerprint, describeModels, hasCredential, isPlaceholder,
  judgeWeakerThanJudged, loadEnvFile, modelFor } from "../src/provider.js";

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
    expect(credentialFingerprint()).toContain(`from ${f}`);
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

  it("prefers the nearest .env when several exist on the way up", () => {
    const nested = join(dir, "packages", "web");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(dir, ".env"), "MF_WHICH=root\n");
    writeFileSync(join(dir, "packages", ".env"), "MF_WHICH=nearer\n");

    const cwd = process.cwd();
    try {
      process.chdir(nested);
      loadEnvFile();
      expect(process.env.MF_WHICH).toBe("nearer");
    } finally {
      process.chdir(cwd);
      delete process.env.MF_WHICH;
    }
  });

  it("does not report a stale source after a later load", () => {
    process.env.OPENAI_API_KEY = "sk-a-riwA";
    const withKey = join(dir, "a.env");
    writeFileSync(withKey, "OPENAI_API_KEY=sk-a-riwA\n");
    loadEnvFile(withKey);
    // The fingerprint names the file it actually applied, not the literal
    // ".env" — in a workspace those are different directories.
    expect(credentialFingerprint()).toContain(`from ${withKey}`);

    const without = join(dir, "b.env");
    writeFileSync(without, "MF_PROBE=x\n");
    loadEnvFile(without);
    expect(credentialFingerprint()).toContain("inherited environment");
  });
});

describe("model profiles", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["MODEL_PROFILE","MODEL_RUNTIME","MODEL_EXTRACTOR","MODEL_JUDGE","MODEL_PERSONA"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k]!;
    }
  });

  it("defaults to dev: terra everywhere while building", () => {
    delete process.env.MODEL_PROFILE;
    expect(activeProfile()).toBe("dev");
    for (const r of ["runtime","extractor","judge","persona"] as const) {
      expect(modelFor(r)).toBe("gpt-5.6-terra");
    }
  });

  it("demo profile upgrades what an audience judges and cheapens the volume", () => {
    process.env.MODEL_PROFILE = "demo";
    expect(modelFor("runtime")).toBe("gpt-5.6-sol");
    expect(modelFor("judge")).toBe("gpt-5.6-sol");
    expect(modelFor("persona")).toBe("gpt-5.6-luna");
    // Extraction stays mid-tier: schema-constrained, but errors corrupt every
    // downstream number, so it is not dropped to luna.
    expect(modelFor("extractor")).toBe("gpt-5.6-terra");
  });

  it("falls back to dev for an unknown profile rather than failing to start", () => {
    process.env.MODEL_PROFILE = "nonsense";
    expect(activeProfile()).toBe("dev");
    expect(modelFor("runtime")).toBe("gpt-5.6-terra");
  });

  it("lets a single role be overridden without changing the profile", () => {
    process.env.MODEL_PROFILE = "dev";
    process.env.MODEL_JUDGE = "gpt-6-astra";
    expect(modelFor("judge")).toBe("gpt-6-astra");
    expect(modelFor("runtime")).toBe("gpt-5.6-terra");
  });

  it("stays silent when the judge is at least as strong as the runtime", () => {
    process.env.MODEL_PROFILE = "dev";
    expect(judgeWeakerThanJudged()).toBeNull();
    process.env.MODEL_PROFILE = "demo";
    expect(judgeWeakerThanJudged()).toBeNull();
  });

  it("warns when the judge is weaker than the runtime it scores", () => {
    // The failure this guards: eval results would measure the judge, not the
    // agent, and the numbers would look fine while meaning nothing.
    process.env.MODEL_RUNTIME = "gpt-5.6-sol";
    process.env.MODEL_JUDGE = "gpt-5.6-luna";
    expect(judgeWeakerThanJudged()).toMatch(/weaker than the runtime/i);
  });

  it("does not warn about an unrecognised custom model id", () => {
    process.env.MODEL_RUNTIME = "some-finetune-v3";
    process.env.MODEL_JUDGE = "gpt-5.6-luna";
    expect(judgeWeakerThanJudged()).toBeNull();
  });

  it("summarises the resolved models for startup logging", () => {
    process.env.MODEL_PROFILE = "demo";
    const d = describeModels();
    expect(d).toContain("profile=demo");
    expect(d).toContain("runtime=gpt-5.6-sol");
    expect(d).toContain("persona=gpt-5.6-luna");
  });
});

describe("credential detection", () => {
  const KEY = "OPENAI_API_KEY";
  let original: string | undefined;
  beforeEach(() => { original = process.env[KEY]; });
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("recognises the shapes people actually paste from an example file", () => {
    for (const k of ["your-key-here", "sk-proj-...-KEY", "<YOUR_KEY>", "sk-...abc", "CHANGEME"]) {
      expect(isPlaceholder(k)).toBe(true);
    }
  });

  it("does not mistake a real key for a placeholder", () => {
    expect(isPlaceholder(`sk-proj-${"a1B2c3D4".repeat(18)}riwA`)).toBe(false);
  });

  it("treats a placeholder as no credential at all", () => {
    // The failure this guards: loadEnvFile deliberately OVERRIDES the inherited
    // environment, so a copied placeholder beats a real key and every call 401s
    // with a credential very obviously present.
    process.env[KEY] = "sk-proj-...-KEY";
    expect(hasCredential()).toBe(false);
    expect(credentialFingerprint()).toMatch(/PLACEHOLDER/);

    process.env[KEY] = `sk-proj-${"x".repeat(140)}riwA`;
    expect(hasCredential()).toBe(true);
    expect(credentialFingerprint()).not.toMatch(/PLACEHOLDER/);
    expect(credentialFingerprint()).toMatch(/ending riwA/);
    expect(credentialFingerprint()).not.toContain("x".repeat(20));
  });

  it("reports no credential when the variable is unset", () => {
    delete process.env[KEY];
    expect(hasCredential()).toBe(false);
    expect(credentialFingerprint()).toBe("none");
  });
});

describe("loadEnvFile", () => {
  it("finds the file from a subdirectory, as a workspace script runs", () => {
    // `npm run start -w @midfunnel/web` has cwd inside the package while .env
    // lives at the repo root. Resolving only against cwd finds nothing in
    // exactly the case people run most.
    const root = mkdtempSync(join(tmpdir(), "envtest-"));
    const nested = join(root, "packages", "web");
    mkdirSync(nested, { recursive: true });
    writeFileSync(join(root, ".env"), "MIDFUNNEL_ENV_PROBE=found-by-walking-up\n");

    const cwd = process.cwd();
    try {
      process.chdir(nested);
      expect(loadEnvFile()).toContain("MIDFUNNEL_ENV_PROBE");
      expect(process.env.MIDFUNNEL_ENV_PROBE).toBe("found-by-walking-up");
    } finally {
      process.chdir(cwd);
      delete process.env.MIDFUNNEL_ENV_PROBE;
      rmSync(root, { recursive: true, force: true });
    }
  });
});
