import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { LeadState } from "@midfunnel/core/events/types";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { bootstrapDiffCI } from "./stats.js";

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

export interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  /** OBSERVED — measured from history, never modelled. */
  observedConversionByDecision: Record<string, number>;
  divergent: Divergence[];
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
  ): Promise<Lift> {
    const [specA, specB] = await Promise.all([
      this.registry.get(journey, va),
      this.registry.get(journey, vb),
    ]);

    const states = await Promise.all(leadIds.map((id) => this.store.fold(id)));

    const outA: ReplayOutcome[] = [];
    const outB: ReplayOutcome[] = [];
    for (const state of states) {
      outA.push(await this.run(specA, state));
      outB.push(await this.run(specB, state));
    }

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
    };
  }

  private async run(spec: JourneySpec, state: LeadState): Promise<ReplayOutcome> {
    const actions = await this.runtime.step(spec, state, { allowFollowUp: false });
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
