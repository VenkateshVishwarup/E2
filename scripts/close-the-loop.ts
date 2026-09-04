/**
 * End-to-end M3: demo moments 6 and 7.
 *
 * Seeds a cohort with a signal planted the way a real one arrives — a campaign
 * that buys cheap leads who cannot pay — runs the journey over it, ingests ad
 * spend, then folds ROI, derives findings, and asks the copilot the question a
 * marketer would actually ask.
 *
 * Runs with no OPENAI_API_KEY: scoring and routing are real either way, and the
 * copilot falls back to keyword routing over the same tools. With a credential
 * the copilot reasons and model cost is metered from real token usage.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { parseSpec } from "@midfunnel/core/journey/spec";
import type { EventInput } from "@midfunnel/core/events/types";
import { score, route, qualifies } from "@midfunnel/runtime/scoring";
import { credentialFingerprint, describeModels, hasCredential, loadEnvFile } from "@midfunnel/runtime/provider";
import { mulberry32 } from "@midfunnel/core/stats/bootstrap";
import { CostIngestor, type MediaSpendRow } from "@midfunnel/intelligence/attribution/cost";
import { AttributionEngine } from "@midfunnel/intelligence/attribution/engine";
import { InsightEngine } from "@midfunnel/intelligence/insights/engine";
import { Copilot } from "@midfunnel/intelligence/copilot/copilot";
import { OfflineCopilot } from "@midfunnel/intelligence/copilot/offline";
import type { Answer } from "@midfunnel/intelligence/copilot/types";

const HERE = dirname(fileURLToPath(import.meta.url));
const V4 = readFileSync(join(HERE, "../packages/core/test/fixtures/mba-v4.yaml"), "utf8");

const TENANT = "t1";
const JOURNEY = "mba-admissions-qualification";
const AGENT = "agent://engati/mba-admissions";
const DAY = "2026-06-01";

/**
 * Three campaigns with genuinely different economics. `meta_scholarships` buys
 * cheap leads who mostly need financing — the journey has no path for them, so
 * it routes them cold and they do not enrol. That is the finding the copilot
 * has to reach on its own.
 */
const CAMPAIGNS = [
  // Cost per lead in paise. Scholarship creative buys cheap traffic that mostly
  // cannot pay; the executive campaign buys expensive traffic that can.
  { id: "meta_scholarships", creatives: ["cr_fees", "cr_emi"],   share: 0.45, financingRate: 0.72, cpl: 150_00 },
  { id: "meta_executive",    creatives: ["cr_career", "cr_alum"], share: 0.35, financingRate: 0.14, cpl: 620_00 },
  { id: "google_search",     creatives: ["cr_brand"],            share: 0.20, financingRate: 0.19, cpl: 450_00 },
] as const;

/** Programme fee in paise: ₹4.5L for an executive MBA. */
const FEE = 4_50_000_00;

const PROGRAMS = ["executive_mba", "full_time_mba", "online_mba"] as const;
const TIMELINES = ["this_intake", "next_intake", "just_exploring"] as const;
const DECIDERS = ["self", "parent", "employer"] as const;

/**
 * Conversion is a probability, not a formula over the lead index.
 *
 * An earlier version of this generator derived programme, timeline and decision
 * maker from `i % 3`, which made all three perfectly collinear: every finding
 * came back as the same 15%-vs-0% split three times over, and the interesting
 * signal was crowded out. Independent draws with a seeded PRNG produce
 * correlated-but-not-identical evidence and genuine noise, so a confidence
 * interval on this data means what it claims to mean.
 */
const P_CONVERT: Record<string, number> = { this_intake: 0.13, next_intake: 0.04, just_exploring: 0.01 };

/**
 * How far a conversation gets. Evidence is collected in the order the runtime
 * asks for it, and `budget_band` is declared `sensitive: true` so it is asked
 * last — which is exactly why it ends up the least-collected field, and why the
 * bottleneck finding has somewhere real to land.
 */
const STAGES: Array<{ p: number; fields: string[] }> = [
  { p: 0.08, fields: [] },
  { p: 0.07, fields: ["target_program"] },
  { p: 0.10, fields: ["target_program", "timeline"] },
  { p: 0.12, fields: ["target_program", "timeline", "decision_maker"] },
  { p: 0.63, fields: ["target_program", "timeline", "decision_maker", "budget_band"] },
];
/** A lead who needs financing rarely enrols when the journey offers no scholarship path. */
const FINANCING_PENALTY = 0.12;
const SELF_BOOST = 1.25;

interface Seeded {
  leadId: string;
  campaignId: string;
  creativeId: string;
  hour: number;
  evidence: Record<string, { value: string; confidence: number }>;
  financing: boolean;
  /** Which evidence fields this conversation actually established. */
  collected: string[];
  /** Lead replies before the conversation stalled. */
  replies: number;
  converts: boolean;
}

/** Deterministic: the numbers on stage are the numbers from rehearsal. */
function cohort(n: number): Seeded[] {
  const rand = mulberry32(20260904);
  const pick = <T,>(xs: readonly T[]) => xs[Math.floor(rand() * xs.length)]!;
  const out: Seeded[] = [];

  for (const campaign of CAMPAIGNS) {
    const count = Math.round(n * campaign.share);
    for (let k = 0; k < count; k++) {
      const financing = rand() < campaign.financingRate;
      const timeline = pick(TIMELINES);
      const decisionMaker = pick(DECIDERS);

      let roll = rand();
      const stage = STAGES.findIndex((st) => (roll -= st.p) <= 0);
      const collected = STAGES[stage === -1 ? STAGES.length - 1 : stage]!.fields;
      const complete = collected.length === 4;

      // Only a conversation that finished qualifying can produce an enrolment.
      const p = complete
        ? P_CONVERT[timeline]! *
          (financing ? FINANCING_PENALTY : 1) *
          (decisionMaker === "self" ? SELF_BOOST : 1)
        : 0;

      out.push({
        leadId: `L_${campaign.id}_${k}`,
        campaignId: campaign.id,
        creativeId: campaign.creatives[k % campaign.creatives.length]!,
        hour: 4 + Math.floor(rand() * 14),
        evidence: {
          target_program: { value: pick(PROGRAMS), confidence: 0.95 },
          timeline: { value: timeline, confidence: 0.9 },
          budget_band: {
            value: financing ? "needs_financing" : (rand() < 0.5 ? "above_15L" : "5L_to_15L"),
            confidence: 0.88,
          },
          decision_maker: { value: decisionMaker, confidence: 0.85 },
        },
        financing,
        collected,
        replies: collected.length === 0 ? 0 : Math.max(1, collected.length - 1),
        converts: rand() < p,
      });
    }
  }
  return out;
}

async function main() {
  loadEnvFile();
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_dev",
  );
  await migrate(pool);
  await pool.query("TRUNCATE events");
  await pool.query("TRUNCATE journey_versions");

  const events = new EventStore(pool, TENANT);
  const registry = new JourneyRegistry(pool, TENANT);
  await registry.publish(V4);
  const spec = parseSpec(V4);

  // ── Run the journey over the cohort and record what happened ─────────────
  const leads = cohort(2000);
  const rows: EventInput[] = [];
  for (const lead of leads) {
    const at = (m: number) => new Date(`${DAY}T${String(lead.hour).padStart(2, "0")}:${String(m).padStart(2, "0")}:00Z`);
    const base = { leadId: lead.leadId, journey: JOURNEY, journeyVersion: 4, agentId: AGENT };
    const s = score(spec, lead.evidence);
    const r = route(spec, s, lead.evidence);

    rows.push({ ...base, type: "LeadIngested", occurredAt: at(0),
      payload: { source: "meta_lead_ads", campaignId: lead.campaignId, creativeId: lead.creativeId, consentScope: "marketing" } });
    rows.push({ ...base, type: "MessageSent", occurredAt: at(1),
      payload: { channel: "whatsapp", renderedText: spec.pinned.disclosure ?? "Hello." } });
    // A stalled conversation produces the turns and evidence it got to, and
    // nothing after. That tail is what the drop-off detector reads.
    for (let t = 0; t < lead.replies; t++) {
      rows.push({ ...base, type: "MessageReceived", occurredAt: at(2 + t),
        payload: { channel: "whatsapp", rawText: "Looking at the executive programme." } });
    }
    for (const field of lead.collected) {
      const v = lead.evidence[field]!;
      rows.push({ ...base, type: "EvidenceExtracted", occurredAt: at(3),
        payload: { field, value: v.value, confidence: v.confidence } });
    }
    if (lead.collected.length < 4) continue;

    // The journey already declares `escalate_when: evidence.budget_band ==
    // needs_financing`. Recording it is what lets the policy-friction detector
    // connect the rule to the conversations it ends.
    if (lead.financing) {
      rows.push({ ...base, type: "PolicyEvaluated", occurredAt: at(3),
        payload: { ruleId: "evidence.budget_band == needs_financing", verdict: "escalate", severity: "high" } });
    }

    rows.push({ ...base, type: "Scored", occurredAt: at(4), payload: { score: s } });
    rows.push({ ...base, type: "Routed", occurredAt: at(4),
      payload: { decision: r.decision, target: r.target, sla: r.sla ?? null } });
    if (r.target.startsWith("handoff.")) {
      rows.push({ ...base, type: "HandoffCreated", occurredAt: at(5),
        payload: { target: r.target, qualified: qualifies(spec, s, lead.evidence) } });
    }
    if (lead.converts) {
      rows.push({ ...base, type: "OutcomeObserved", occurredAt: new Date("2026-07-01T00:00:00Z"),
        payload: { outcome: "paid", amount: FEE, currency: "INR", source: "crm" } });
    }
  }
  await events.appendMany(rows);

  // ── Ingest the ad spend the finance team already has ─────────────────────
  const spend: MediaSpendRow[] = CAMPAIGNS.map((c) => ({
    campaignId: c.id, day: DAY,
    amount: c.cpl * leads.filter((l) => l.campaignId === c.id).length,
    currency: "INR",
  }));
  const ingested = await new CostIngestor(events).ingestMedia(spend);

  // ── Moment 6: ROI, closed loop ───────────────────────────────────────────
  const roi = await new AttributionEngine(events, registry).roll(JOURNEY);
  const money = (v: number | null | undefined) =>
    v === null || v === undefined ? "—" : `₹${Math.round(v / 100).toLocaleString("en-IN")}`;

  console.log(`
──────────────────────────────────────────────────────────────
  M3 — THE LOOP        ${describeModels()}
                       credential: ${credentialFingerprint()}
──────────────────────────────────────────────────────────────
  MOMENT 6 · ROI, attributed to journey version

  ${leads.length} leads · ${ingested.leadsCharged} charged with allocated media spend
`);

  const head = ["campaign / creative".padEnd(26), "leads".padStart(6), "qual".padStart(6),
                "enrol".padStart(6), "spend".padStart(11), "cost/enrol".padStart(12), "ROAS".padStart(7)];
  console.log("  " + head.join(" "));
  for (const node of roi.tree) {
    const line = (label: string, n: typeof node, indent: string) => {
      const roas = n.returnOnSpend.revenue;
      console.log("  " + [
        (indent + label).padEnd(26),
        String(n.leads).padStart(6),
        String(n.counts.qualified_lead ?? 0).padStart(6),
        String(n.counts.conversion ?? 0).padStart(6),
        money(n.totalCost).padStart(11),
        money(n.costPer.conversion).padStart(12),
        (roas === null ? "—" : `${roas.toFixed(1)}x`).padStart(7),
      ].join(" "));
    };
    line(node.value, node, "");
    for (const child of node.children) line(child.value, child, "  ↳ ");
  }
  console.log("  " + "-".repeat(84));
  console.log("  " + [
    "TOTAL".padEnd(26),
    String(roi.total.leads).padStart(6),
    String(roi.total.counts.qualified_lead ?? 0).padStart(6),
    String(roi.total.counts.conversion ?? 0).padStart(6),
    money(roi.total.totalCost).padStart(11),
    money(roi.total.costPer.conversion).padStart(12),
    (roi.total.returnOnSpend.revenue === null ? "—" : `${roi.total.returnOnSpend.revenue.toFixed(1)}x`).padStart(7),
  ].join(" "));

  console.log(`
  media ${money(roi.total.mediaCost)} allocated · model ${money(roi.total.modelCost)} metered`);
  if (roi.total.modelCost === 0) {
    console.log("  model cost is zero because this run made no model calls — it is not an estimate");
  }
  for (const c of roi.caveats) console.log(`  · ${c}`);

  // ── The Insight Engine ───────────────────────────────────────────────────
  const report = await new InsightEngine(events, registry).insights(JOURNEY);
  console.log(`
──────────────────────────────────────────────────────────────
  FINDINGS       ${report.findings.length} over ${report.leadsAnalysed} leads
──────────────────────────────────────────────────────────────`);
  for (const f of report.findings) {
    console.log(`\n  [${f.severity.toUpperCase()}] ${f.code}`);
    console.log(`  ${f.claim}`);
    console.log(`  ${f.detail}  (n=${f.n})`);
    if (f.suggestion) console.log(`  → ${f.suggestion}`);
  }
  for (const s of report.skipped) console.log(`\n  [skipped] ${s.code}: ${s.reason}`);

  // ── Moment 7: the copilot ────────────────────────────────────────────────
  const offline = new OfflineCopilot(events, registry);
  const copilot = hasCredential() ? new Copilot(events, registry) : offline;

  const question = "Why is my needs_financing cohort converting worse?";
  console.log(`
──────────────────────────────────────────────────────────────
  MOMENT 7 · The copilot
──────────────────────────────────────────────────────────────

  Q: ${question}`);

  // A credential that turns out to be dead must not end the demo. Fall back
  // and say so, rather than throwing a stack trace onto the screen.
  const answer: Answer = await copilot.ask(JOURNEY, question).catch(async (err: Error) => {
    console.log(`\n  [model unavailable: ${err.message.split("\n")[0]}]`);
    console.log("  falling back to the offline copilot — same tools, no reasoning");
    return offline.ask(JOURNEY, question);
  });
  console.log(`\n  A: ${answer.text}`);
  console.log(`\n  read from: ${answer.usedTools.join(" → ")}` +
              `${answer.offline ? "   (offline — keyword routed, same tools)" : ""}`);

  if (answer.view?.kind === "bar") {
    console.log(`\n  ${answer.view.title}`);
    const max = Math.max(...answer.view.series.map((s) => s.value), 1);
    for (const s of answer.view.series) {
      console.log(`    ${s.label.padEnd(34)} ${"█".repeat(Math.round((s.value / max) * 28))} ${s.value}${answer.view.unit ?? ""}`);
    }
  }

  if (answer.diff) {
    console.log(`\n  PROPOSED  v${answer.diff.fromVersion} → v${answer.diff.toVersion}`);
    console.log(`  ${answer.diff.rationale}`);
    for (const c of answer.diff.changes) {
      console.log(`    ${c.path.padEnd(40)} ${JSON.stringify(c.before) ?? "—"} → ${JSON.stringify(c.after)}`);
    }
    console.log("  parsed, linted and diffed before it was shown — it would publish as it stands");
    for (const w of answer.diff.warnings) console.log(`    [lint: ${w.code}] ${w.message}`);
  } else {
    console.log("\n  no spec change proposed");
  }
  console.log("──────────────────────────────────────────────────────────────");

  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
