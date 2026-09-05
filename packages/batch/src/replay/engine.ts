import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { bootstrapDiffCI } from "@midfunnel/core/stats/bootstrap";
import { requiredEvidenceFields } from "@midfunnel/core/journey/spec";
import { mapLimit } from "./concurrency.js";

export interface ReplayOutcome {
  leadId: string;
  decision: string;
  qualified: boolean;
  turns: number;
}

export interface Divergence {
  leadId: string;
  a: ReplayOutcome;
  b: ReplayOutcome;
  actualOutcome: string | null;
}

export interface ReplayOptions {
  /** Concurrent extractions. Enough to be quick, small enough to be polite. */
  concurrency?: number;
  /**
   * Re-extract evidence even for leads whose evidence is already in the log.
   * Off by default; see the note in `replay`.
   */
  forceExtraction?: boolean;
}

export interface ReplayCost {
  leads: number;
  /** Leads whose evidence had to be extracted — the only ones that cost money. */
  extracted: number;
  /** Leads whose evidence was already recorded against the transcript. */
  reused: number;
  /**
   * Actual model spend, metered.
   *
   * Replay writes no events — it is a read over history — so its spend appears
   * in no CostObserved row and would otherwise be invisible. A job that can
   * quietly cost real money has to report what it cost.
   */
  usd: number;
}

export interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  /** OBSERVED — measured from history, never modelled. */
  observedConversionByDecision: Record<string, number>;
  divergent: Divergence[];
  /** What this replay actually cost in model calls, so the number is not a guess. */
  cost: ReplayCost;
}

const CONVERTED = new Set(["enrolled", "paid"]);

export class ReplayEngine {
  constructor(
    private readonly store: EventStore,
    private readonly registry: JourneyRegistry,
    private readonly runtime: AgentRuntime,
  ) {}

  /**
   * Replays a historical cohort through two journey versions.
   *
   * The runtime used here must be identical in model and effort to the
   * production runtime — otherwise the counterfactual estimates a different
   * system and the lift figure is meaningless.
   *
   * Writes nothing: replay is a pure read over history.
   */
  async replay(
    journey: string, va: number, vb: number, leadIds: string[],
    opts: ReplayOptions = {},
  ): Promise<Lift> {
    const [specA, specB] = await Promise.all([
      this.registry.get(journey, va),
      this.registry.get(journey, vb),
    ]);

    // One query for the whole cohort. Folding lead by lead used to dominate the
    // wall time before a single model call was made.
    const states = await this.store.foldMany(leadIds);

    // When both versions declare the same evidence contract, extract ONCE and
    // run both arms against it. Halving the model calls is the lesser reason:
    // extracting per arm injects model variance into a comparison whose whole
    // purpose is to isolate the difference between two journey versions.
    // Standalone extraction is an optional capability of a runtime: a stub or an
    // alternative implementation may only offer `step`. Without it, fall back to
    // extracting per arm — correct, just slower.
    const canShare =
      JSON.stringify(specA.evidence) === JSON.stringify(specB.evidence) &&
      typeof (this.runtime as { extract?: unknown }).extract === "function";

    // A lead the journey has already run carries its EvidenceExtracted events,
    // so `foldMany` hands back the evidence already. Re-deriving it from the
    // same transcript costs a model call to reproduce a fact that is on the
    // record — and on a 2000-lead cohort that is the whole wall time and the
    // whole bill. Extract only for leads whose evidence is genuinely absent,
    // which is the raw-import case.
    const required = requiredEvidenceFields(specA);
    const needsExtraction = (state: LeadState) =>
      opts.forceExtraction === true ||
      required.some((f) => {
        const got = state.evidence[f];
        return got === undefined || got.value === null || got.value === undefined;
      });

    const prepared = canShare
      ? await mapLimit(states, opts.concurrency ?? 8, async (state) =>
          needsExtraction(state)
            ? { ...state, evidence: { ...state.evidence, ...await this.runtime.extract(specA, state.turns) } }
            : state)
      : states;

    const cost: ReplayCost = {
      leads: states.length,
      extracted: canShare ? states.filter(needsExtraction).length : states.length * 2,
      reused: canShare ? states.filter((s) => !needsExtraction(s)).length : 0,
      usd: 0,
    };

    const step = { reuseEvidence: canShare };
    const outA = await mapLimit(prepared, opts.concurrency ?? 8, (s) => this.run(specA, s, step));
    const outB = await mapLimit(prepared, opts.concurrency ?? 8, (s) => this.run(specB, s, step));

    // OBSERVED: what actually happened, bucketed by the decision v_a reached.
    const observed = observedConversion(states, outA);

    const rate = (o: ReplayOutcome[]) => (o.length ? o.filter((x) => x.qualified).length / o.length : 0);
    const rateA = rate(outA);
    const rateB = rate(outB);

    // MODELLED: apply the observed per-decision conversion rate to each arm.
    const project = (o: ReplayOutcome[]) =>
      round2(o.reduce((sum, x) => sum + (observed[x.decision] ?? 0), 0));

    const divergent: Divergence[] = [];
    states.forEach((s, i) => {
      const a = outA[i]!; const b = outB[i]!;
      if (a.decision !== b.decision) {
        divergent.push({
          leadId: s.leadId, a, b,
          actualOutcome: s.outcomes.at(-1)?.outcome ?? null,
        });
      }
    });

    return {
      n: states.length,
      a: { version: va, qualifiedRate: round4(rateA), projectedConversions: project(outA) },
      b: { version: vb, qualifiedRate: round4(rateB), projectedConversions: project(outB) },
      absoluteLift: round4(rateB - rateA),
      ci95: bootstrapDiffCI(outA.map((o) => o.qualified), outB.map((o) => o.qualified), { seed: 1 }),
      observedConversionByDecision: observed,
      divergent,
      cost: { ...cost, usd: round4(this.spend()) },
    };
  }

  /** Metered spend for this replay, if the runtime carries a meter. */
  private spend(): number {
    const meter = (this.runtime as { meter?: { drain(): Array<{ usd: number }> } }).meter;
    return meter ? meter.drain().reduce((s, c) => s + c.usd, 0) : 0;
  }

  private async run(
    spec: JourneySpec, state: LeadState, opts: { reuseEvidence: boolean },
  ): Promise<ReplayOutcome> {
    const actions = await this.runtime.step(spec, state, {
      allowFollowUp: false, reuseEvidence: opts.reuseEvidence,
    });
    let decision = "cold";
    let qualified = false;
    for (const a of actions) {
      if (a.kind === "route") decision = a.decision;
      if (a.kind === "complete") qualified = a.qualified;
      if (a.kind === "escalate") decision = "escalated";
    }
    return { leadId: state.leadId, decision, qualified, turns: state.turns.length };
  }
}

/** Historical conversion rate per decision bucket. Pure measurement. */
function observedConversion(
  states: LeadState[], outcomes: ReplayOutcome[],
): Record<string, number> {
  const tally: Record<string, { converted: number; total: number }> = {};
  states.forEach((s, i) => {
    const decision = outcomes[i]!.decision;
    const b = (tally[decision] ??= { converted: 0, total: 0 });
    b.total++;
    if (s.outcomes.some((o) => CONVERTED.has(o.outcome))) b.converted++;
  });
  return Object.fromEntries(
    Object.entries(tally).map(([k, v]) => [k, round4(v.converted / v.total)]),
  );
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;
const round2 = (v: number) => Math.round(v * 100) / 100;
