/**
 * End-to-end M1 verification: import a synthetic historical cohort, publish two
 * journey versions, replay one against the other, print the lift.
 *
 * Uses a deterministic stub runtime so it needs no OPENAI_API_KEY. Swap in
 * `new AgentRuntime()` to run it against the real model.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { parseSpec } from "@midfunnel/core/journey/spec";
import { AgentRegistry } from "@midfunnel/core/agent/registry";
import { ToolBroker, mockBindings } from "@midfunnel/runtime/broker";
import { score, route, qualifies, evidenceComplete } from "@midfunnel/runtime/scoring";
import type { Action } from "@midfunnel/runtime/step";
import { ImportBoundary, type HistoricalLead } from "@midfunnel/batch/import/importer";
import { ReplayEngine } from "@midfunnel/batch/replay/engine";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../packages/core/test/fixtures/mba-v4.yaml"), "utf8");
// v3 is the same journey before decision_maker was properly weighted: it
// under-valued who actually makes the decision. Not a removed signal (which
// would cap v3 below the qualifying threshold and make the lift degenerate) —
// an under-weighted one, which is what a real v3 -> v4 change looks like.
const V3 = V4.replace("version: 4", "version: 3")
             .replace("    decision_maker.self: 15", "    decision_maker.self: 5");

const TENANT = "t1";
const JOURNEY = "mba-admissions-qualification";
const AGENT = "agent://engati/mba-admissions";

const PROGRAMS = ["executive_mba", "full_time_mba", "online_mba"] as const;
const TIMELINES = ["this_intake", "next_intake", "just_exploring"] as const;
const BUDGETS = ["under_5L", "5L_to_15L", "above_15L", "needs_financing"] as const;
const DECIDERS = ["self", "parent", "employer"] as const;

/** Deterministic pseudo-cohort so the printed numbers are reproducible. */
function makeCohort(n: number): Array<HistoricalLead & { truth: Record<string, string> }> {
  const out = [];
  for (let i = 0; i < n; i++) {
    const truth = {
      target_program: PROGRAMS[i % 3]!,
      timeline: TIMELINES[i % 3]!,
      budget_band: BUDGETS[i % 4]!,
      decision_maker: DECIDERS[i % 3]!,
    };
    // Historical conversion correlates with intent, as it would in real data.
    const converted = truth.timeline === "this_intake" && truth.budget_band !== "under_5L";
    out.push({
      externalId: `seed-${i}`,
      source: "meta_lead_ads",
      campaignId: `camp_${i % 3}`,
      creativeId: `cr_${i % 5}`,
      consentScope: "marketing",
      turns: [
        { role: "agent" as const, text: "Which programme are you considering?", at: "2026-06-01T10:00:00Z" },
        { role: "lead" as const, text: `${truth.target_program}, ${truth.timeline}, budget ${truth.budget_band}, decided by ${truth.decision_maker}. Call me on +919876543210`, at: "2026-06-01T10:01:00Z" },
      ],
      ...(converted
        ? { outcome: { outcome: "enrolled" as const, amount: 45000000, currency: "INR", observedAt: "2026-07-01T00:00:00Z" } }
        : {}),
      truth,
    });
  }
  return out;
}

/** Stub runtime: real scoring and routing, evidence read from the seeded truth. */
function stubRuntime(truthByLead: Map<string, Record<string, string>>) {
  return {
    async step(spec: ReturnType<typeof parseSpec>, state: { leadId: string }): Promise<Action[]> {
      const truth = truthByLead.get(state.leadId) ?? {};
      const evidence = Object.fromEntries(
        Object.entries(truth).map(([k, v]) => [k, { value: v, confidence: 0.95 }]),
      );
      if (!evidenceComplete(spec, evidence)) return [{ kind: "complete", qualified: false }];
      const s = score(spec, evidence);
      const r = route(spec, s, evidence);
      return [
        { kind: "score", score: s },
        { kind: "route", ...r },
        { kind: "complete", qualified: qualifies(spec, s, evidence) },
      ];
    },
  } as never;
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
  // Owns the synthetic historical cohort and nothing else. A TRUNCATE here
  // would delete every real conversation someone had with the agent.
  await pool.query("DELETE FROM events WHERE lead_id LIKE 'L\\_%'");

  const events = new EventStore(pool, TENANT);
  const registry = new JourneyRegistry(pool, TENANT);
  await reseedVersion(registry, V3);
  await reseedVersion(registry, V4);

  const cohort = makeCohort(400);
  const ids = await new ImportBoundary(events, {
    journey: JOURNEY, journeyVersion: 3, agentId: "agent://engati/import",
  }).import(cohort);

  const truthByLead = new Map(ids.map((id, i) => [id, cohort[i]!.truth]));

  // --- Privilege enforcement, on the record -------------------------------
  const spec = parseSpec(V4);
  const agents = AgentRegistry.fromSpec(spec);
  const principal = agents.get(AGENT);
  const broker = new ToolBroker(agents, events, mockBindings);
  const ctx = { leadId: ids[0]!, journey: JOURNEY, journeyVersion: 4 };
  const okCall = await broker.invoke(ctx, principal, "crm.upsert_lead", { email: "a@b.com" });
  const badCall = await broker.invoke(ctx, principal, "payment.charge_card", { amount: 999 });

  // --- The money shot ------------------------------------------------------
  const lift = await new ReplayEngine(events, registry, stubRuntime(truthByLead))
    .replay(JOURNEY, 3, 4, ids);

  // --- Demo moment 2: declare, don't prompt --------------------------------
  // The whole edit is making decision_maker required. In a prompt-based system
  // this is a 400-word rewrite you cannot diff or attribute lift to.
  const V5 = V4.replace("version: 4", "version: 5").replace(
    "  decision_maker:\n    type: enum[self, parent, employer]\n    required: false",
    "  decision_maker:\n    type: enum[self, parent, employer]\n    required: true",
  );
  await reseedVersion(registry, V5);
  const changes = await registry.diff(JOURNEY, 4, 5);

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const scrubbed = await events.query({ leadId: ids[0]!, type: "MessageReceived" });

  console.log(`
──────────────────────────────────────────────────────────────
  M1 END-TO-END
──────────────────────────────────────────────────────────────
  Cohort imported          ${lift.n} leads
  PII scrubbed on import   ${String((scrubbed[0]!.payload as { rawText: string }).rawText).includes("[PHONE]") ? "yes — phone redacted" : "NO — LEAK"}

  Privilege enforcement
    crm.upsert_lead        ${okCall.ok ? "allowed" : "denied"}
    payment.charge_card    ${badCall.ok ? "ALLOWED (BUG)" : "denied"}
    AuthorizationDenied    ${(await events.query({ type: "AuthorizationDenied" })).length} event(s) logged
    events without agent   ${(await pool.query("SELECT count(*)::int n FROM events WHERE agent_id = ''")).rows[0].n}

  Replay  v${lift.a.version} -> v${lift.b.version}
    qualified  v3           ${pct(lift.a.qualifiedRate)}
    qualified  v4           ${pct(lift.b.qualifiedRate)}
    lift                    ${lift.absoluteLift >= 0 ? "+" : ""}${pct(lift.absoluteLift)}  (95% CI ${pct(lift.ci95[0])} .. ${pct(lift.ci95[1])})
    diverged on             ${lift.divergent.length} leads

  OBSERVED (from history)   ${JSON.stringify(lift.observedConversionByDecision)}
  MODELLED (projected)      v3 ${lift.a.projectedConversions} · v4 ${lift.b.projectedConversions}

  Spec diff v4 -> v5        ${changes.length} change(s)
${changes.map((c) => `    ${c.path.padEnd(34)} ${JSON.stringify(c.before)} -> ${JSON.stringify(c.after)}`).join("\n")}
──────────────────────────────────────────────────────────────`);

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
