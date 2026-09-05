/**
 * End-to-end M2 verification: demo moments 3, 4 and 5.
 *
 * Runs entirely on ScriptedReplier + KeywordExtractor, so it needs no
 * OPENAI_API_KEY. The plumbing is real; the agent quality it reports is not
 * representative until a credential is present.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { lintSpec, parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { generatePersonas } from "@midfunnel/batch/simulate/persona";
import { ScriptedReplier } from "@midfunnel/batch/simulate/replier";
import { SimulationRunner } from "@midfunnel/batch/simulate/runner";
import { scoreConversation } from "@midfunnel/batch/eval/scorecard";
import { aggregate, evaluateAlerts } from "@midfunnel/batch/eval/alerts";
import { compareRuns, type ArmResult } from "@midfunnel/batch/experiment/compare";
import { TrafficAllocator } from "@midfunnel/batch/experiment/allocator";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../packages/core/test/fixtures/mba-v4.yaml"), "utf8");
// v5 fixes what the linter flags in v4: decision_maker carries 15 points but is
// optional, and the runtime stops asking once required evidence is complete, so
// v4 tops out at 65 against a threshold of 70 and can never qualify anyone.
// Making the field required is the entire edit - demo moment 2.
const V5 = V4.replace("version: 4", "version: 5").replace(
  "  decision_maker:\n    type: enum[self, parent, employer]\n    required: false",
  "  decision_maker:\n    type: enum[self, parent, employer]\n    required: true");
// A deliberately bad version: the pinned disclosure promises admission, which
// policy.never forbids. Every conversation opens with a breach.
const V6 = V4.replace("version: 4", "version: 6").replace(
  `  disclosure: "Hi {{name}}, I'm an AI assistant from {{institute}}."`,
  `  disclosure: "Hi {{name}}, you are guaranteed admission with your profile."`);

const TENANT = "t1";
const JOURNEY = "mba-admissions-qualification";
const N = 500;

const runtime = () => new AgentRuntime(new KeywordExtractor() as never, {
  responses: {
    create: async (body: { input: string }) => {
      const { ask_about } = JSON.parse(body.input) as { ask_about: { field: string } };
      return { output_text: `Could you tell me your ${ask_about.field.replace(/_/g, " ")}?` };
    },
  },
} as never);

async function runVersion(
  pool: ReturnType<typeof createPool>, registry: JourneyRegistry, version: number, seed: number,
) {
  const spec = await registry.get(JOURNEY, version);
  const personas = generatePersonas(spec, N, seed);
  const store = new EventStore(pool, TENANT, "sim");
  const summary = await new SimulationRunner(store, runtime(), new ScriptedReplier())
    .run(spec, personas, { runId: `run_v${version}_s${seed}` });

  const byId = new Map(personas.map((p) => [p.id, p]));
  const cards = [];
  for (const r of summary.results) {
    cards.push(scoreConversation(spec, await store.fold(r.leadId), byId.get(r.personaId)!, {
      escalated: r.outcome === "escalated", ghosted: r.outcome === "ghosted",
    }));
  }
  return { spec, summary, cards, quality: aggregate(cards) };
}

/**
 * Seed scripts own the fixture versions they publish, so an edited fixture
 * replaces them. Versions anyone created in the console are left alone —
 * immutability still holds for everything this script did not author.
 */
async function reseedVersion(registry: JourneyRegistry, yamlText: string): Promise<void> {
  const spec = parseSpec(yamlText);
  await registry.deleteVersion(spec.journey, spec.version);
  await registry.publish(yamlText);
}

async function main() {
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_dev",
  );
  await migrate(pool);
  // Owns simulated runs. Live traffic is a different env and stays put.
  await pool.query("DELETE FROM events WHERE env = 'sim'");

  const registry = new JourneyRegistry(pool, TENANT);
  for (const y of [V4, V5, V6]) await reseedVersion(registry, y);

  const pct = (v: number | null) => (v === null ? "—" : `${(v * 100).toFixed(1)}%`);
  const lintV4 = lintSpec(parseSpec(V4));
  const lintV5 = lintSpec(parseSpec(V5));

  // ---- Moment 3: sandbox --------------------------------------------------
  const good = await runVersion(pool, registry, 4, 1);
  const goodAlerts = evaluateAlerts(good.quality);

  // ---- Moment 4: break it on purpose --------------------------------------
  const bad = await runVersion(pool, registry, 6, 1);
  const badAlerts = evaluateAlerts(bad.quality);

  // ---- Moment 5: A/B ------------------------------------------------------
  const b = await runVersion(pool, registry, 5, 1);
  const arm = (r: typeof good, v: number): ArmResult =>
    ({ target: `${JOURNEY}@${v}`, summary: r.summary, quality: r.quality });
  const board = compareRuns(arm(good, 4), arm(b, 5), good.cards, b.cards);

  const tiny = compareRuns(arm(good, 4), arm(b, 5), good.cards.slice(0, 8), b.cards.slice(0, 8));

  // ---- Isolation ----------------------------------------------------------
  const liveVisible = (await new EventStore(pool, TENANT, "live").query({})).length;
  const simVisible = (await new EventStore(pool, TENANT, "sim").query({ limit: 1 })).length;

  // ---- Allocator ----------------------------------------------------------
  const alloc = new TrafficAllocator([{ source: "camp_1", arms: [
    { target: `${JOURNEY}@4`, weight: 90 }, { target: "external:engati", weight: 10 },
  ] }]);
  const split = alloc.split("camp_1", Array.from({ length: 1000 }, (_, i) => `lead_${i}`));

  console.log(`
──────────────────────────────────────────────────────────────
  M2 END-TO-END   (${N} personas per run, no API key)
──────────────────────────────────────────────────────────────
  STATIC LINT (before a single conversation runs)
    v4  ${lintV4.length === 0 ? "clean" : lintV4.map((w) => w.code).join(", ")}
${lintV4.map((w) => `      ${w.message}`).join("\n")}
    v5  ${lintV5.length === 0 ? "clean" : lintV5.map((w) => w.code).join(", ")}

  MOMENT 3 — sandbox, v4
    completed / escalated / ghosted   ${good.summary.completed} / ${good.summary.escalated} / ${good.summary.ghosted}
    evidence completeness             ${pct(good.quality.meanCompleteness)}
    evidence correctness (vs truth)   ${pct(good.quality.meanCorrectness)}
    qualified                         ${pct(good.quality.qualifiedRate)}
    alerts                            ${goodAlerts.length === 0 ? "none" : goodAlerts.map((a) => a.id).join(", ")}

  MOMENT 4 — deliberately bad v6 (disclosure promises admission)
    policy violation rate             ${pct(bad.quality.violationRate)}
    alerts fired                      ${badAlerts.length}
${badAlerts.map((a) => `      [${a.severity.toUpperCase()}] ${a.message}`).join("\n")}

  MOMENT 5 — A/B, v4 vs v5 (decision_maker optional -> required)
    v4 qualified                      ${pct(good.quality.qualifiedRate)}
    v5 qualified                      ${pct(b.quality.qualifiedRate)}
    delta                             ${board.qualifiedDelta >= 0 ? "+" : ""}${pct(board.qualifiedDelta)}  (95% CI ${pct(board.qualifiedCi95[0])} .. ${pct(board.qualifiedCi95[1])})
    verdict  (n=${N})                  ${board.verdict}
    verdict  (n=8, same data)         ${tiny.verdict}

  ISOLATION
    events visible to a LIVE store    ${liveVisible}   (must be 0)
    events visible to a SIM store     ${simVisible > 0 ? "present" : "NONE — BUG"}

  ALLOCATOR (parallel-run split 90/10)
${Object.entries(split).map(([t, ks]) => `      ${t.padEnd(34)} ${ks.length}`).join("\n")}
──────────────────────────────────────────────────────────────`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
