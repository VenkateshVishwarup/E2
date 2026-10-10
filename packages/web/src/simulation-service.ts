import type { Pool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { generatePersonas } from "@midfunnel/batch/simulate/persona";
import { ScriptedReplier, ModelReplier, type Replier } from "@midfunnel/batch/simulate/replier";
import { SimulationRunner, type RunSummary } from "@midfunnel/batch/simulate/runner";
import { scoreConversation, type Scorecard } from "@midfunnel/batch/eval/scorecard";
import { aggregate, evaluateAlerts } from "@midfunnel/batch/eval/alerts";
import { varianceAcross, type RepeatRun } from "@midfunnel/batch/eval/variance";
import {
  compareRanges, compareRuns, type ArmResult, type Scoreboard,
} from "@midfunnel/batch/experiment/compare";
import type { SimulationResult, SimulationService } from "./deps.js";

/**
 * Wires the simulation pipeline: personas -> runner -> scorecards -> alerts.
 *
 * Uses a `sim`-scoped EventStore throughout, so nothing it writes is visible to
 * any live-scoped read.
 */
export class LiveSimulationService implements SimulationService {
  constructor(
    private readonly pool: Pool,
    private readonly tenantId: string,
    private readonly registry: JourneyRegistry,
    private readonly runtime: AgentRuntime,
    private readonly replier: Replier,
  ) {}

  /**
   * `repeats` runs the SAME personas through the version that many times. A
   * deterministic configuration produces identical repeats and the report says
   * so; anything with a model in the loop produces a range, which is the honest
   * figure for an agent that may not take the same path twice.
   */
  async run(
    journey: string, version: number, n: number, seed = 1, repeats = 1,
  ): Promise<SimulationResult> {
    const runs: RepeatRun[] = [];
    let first: RunSummary | undefined;
    for (let i = 0; i < repeats; i++) {
      const { summary, cards } = await this.execute(journey, version, n, seed, i);
      const quality = aggregate(cards);
      runs.push({ runId: summary.runId, quality, alerts: evaluateAlerts(quality) });
      first ??= summary;
    }
    const { quality, alerts } = runs[0]!;
    return {
      summary: first!, quality, alerts,
      ...(repeats > 1 ? { variance: varianceAcross(runs) } : {}),
    };
  }

  /**
   * `repeats` runs BOTH arms that many times over the same personas.
   *
   * One run each is one draw from each version's distribution, and for a version
   * that may not take the same path twice that is how a difference which is
   * really noise gets shipped. The headline stays the first run against the
   * first run, so a client that ignores `variance` reads exactly what it did
   * before; `variance.qualified` then says whether that verdict survived.
   */
  async compare(
    journey: string, va: number, vb: number, n: number, seed = 1, repeats = 1,
  ): Promise<Scoreboard> {
    const arm = (r: { summary: RunSummary; cards: Scorecard[] }, v: number): ArmResult => ({
      target: `${journey}@${v}`, summary: r.summary, quality: aggregate(r.cards),
    });

    // Same seed both sides and on every repeat: the identical personas meet both
    // versions, which is what makes the paired bootstrap in compareRuns valid
    // and what isolates the model's variance from the cohort's.
    const runsA: RepeatRun[] = [];
    const runsB: RepeatRun[] = [];
    let firstA: { summary: RunSummary; cards: Scorecard[] } | undefined;
    let firstB: { summary: RunSummary; cards: Scorecard[] } | undefined;

    for (let i = 0; i < repeats; i++) {
      const a = await this.execute(journey, va, n, seed, i);
      const b = await this.execute(journey, vb, n, seed, i);
      firstA ??= a;
      firstB ??= b;
      for (const [runs, r] of [[runsA, a], [runsB, b]] as const) {
        const quality = aggregate(r.cards);
        runs.push({ runId: r.summary.runId, quality, alerts: evaluateAlerts(quality) });
      }
    }

    const board = compareRuns(arm(firstA!, va), arm(firstB!, vb), firstA!.cards, firstB!.cards);
    if (repeats < 2) return board;

    const varianceA = varianceAcross(runsA);
    const varianceB = varianceAcross(runsB);
    const qualified = compareRanges(varianceA, varianceB, board.verdict);
    return qualified
      ? { ...board, variance: { a: varianceA, b: varianceB, qualified } }
      : board;
  }

  private async execute(journey: string, version: number, n: number, seed: number, repeat = 0) {
    const spec = await this.registry.get(journey, version);
    const personas = generatePersonas(spec, n, seed);
    const store = new EventStore(this.pool, this.tenantId, "sim");

    // The repeat is in the id because two runs can start in the same
    // millisecond, and a shared runId would fold both into one set of leads.
    const runId = `run_${version}_${seed}_${Date.now()}_${repeat}`;
    const summary = await new SimulationRunner(store, this.runtime, this.replier)
      .run(spec, personas, { runId });

    const byId = new Map(personas.map((p) => [p.id, p]));
    const cards: Scorecard[] = [];
    for (const r of summary.results) {
      const persona = byId.get(r.personaId);
      if (!persona) continue;
      cards.push(scoreConversation(spec, await store.fold(r.leadId), persona, {
        escalated: r.outcome === "escalated",
        ghosted: r.outcome === "ghosted",
      }));
    }
    return { summary, cards };
  }
}

/** Model-backed personas when a credential exists; deterministic otherwise. */
export function chooseReplier(hasCredential: boolean): Replier {
  return hasCredential ? new ModelReplier() : new ScriptedReplier();
}
