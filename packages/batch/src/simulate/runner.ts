import type { EventStore } from "@midfunnel/core/events/store";
import type { EventInput, LeadState } from "@midfunnel/core/events/types";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { AgentRuntime } from "@midfunnel/runtime/step";
import { actionsToEvents } from "@midfunnel/runtime/persist";
import type { Persona } from "./persona.js";
import type { Replier } from "./replier.js";

export interface LeadOutcome {
  leadId: string;
  personaId: string;
  /** ghosted and exhausted are indistinguishable from the event log alone, so
   *  the runner reports them rather than leaving consumers to guess. */
  outcome: "completed" | "escalated" | "ghosted" | "exhausted";
  qualified: boolean;
}

export interface RunSummary {
  runId: string;
  journey: string;
  journeyVersion: number;
  n: number;
  completed: number;
  qualified: number;
  escalated: number;
  ghosted: number;
  avgTurns: number;
  results: LeadOutcome[];
}

export interface RunOptions {
  runId?: string;
  agentId?: string;
}

interface ConversationResult {
  turns: number;
  completed: boolean;
  qualified: boolean;
  escalated: boolean;
  ghosted: boolean;
}

export class SimulationRunner {
  constructor(
    private readonly store: EventStore,
    private readonly runtime: AgentRuntime,
    private readonly replier: Replier,
  ) {}

  /**
   * Drives each persona through the journey and writes real events.
   *
   * `allowFollowUp` is true here — unlike replay, there is a synthetic lead to
   * answer the question, so the runtime's full conversational behaviour is
   * exercised. That is what makes a simulation run a sandbox rather than a
   * scoring exercise.
   */
  async run(spec: JourneySpec, personas: Persona[], opts: RunOptions = {}): Promise<RunSummary> {
    const runId = opts.runId ?? `run_${Date.now()}`;
    const agentId = opts.agentId ?? spec.agent.identity;

    let completed = 0, qualified = 0, escalated = 0, ghosted = 0, turnTotal = 0;
    const results: LeadOutcome[] = [];

    for (const persona of personas) {
      const leadId = `sim_${runId}_${persona.id}`;
      const base = { leadId, journey: spec.journey, journeyVersion: spec.version, agentId, runId };

      await this.store.append({
        ...base, type: "LeadIngested",
        payload: { source: "simulation", personaId: persona.id, campaignId: "sim" },
      });

      const outcome = await this.conversation(spec, persona, base);
      turnTotal += outcome.turns;
      if (outcome.escalated) escalated++;
      else if (outcome.ghosted) ghosted++;
      else if (outcome.completed) { completed++; if (outcome.qualified) qualified++; }

      results.push({
        leadId, personaId: persona.id,
        outcome: outcome.escalated ? "escalated"
               : outcome.ghosted ? "ghosted"
               : outcome.completed ? "completed"
               : "exhausted",
        qualified: outcome.qualified,
      });
    }

    return {
      runId, journey: spec.journey, journeyVersion: spec.version,
      n: personas.length, completed, qualified, escalated, ghosted,
      avgTurns: personas.length ? Math.round((turnTotal / personas.length) * 10) / 10 : 0,
      results,
    };
  }

  private async conversation(
    spec: JourneySpec,
    persona: Persona,
    base: { leadId: string; journey: string; journeyVersion: number; agentId: string; runId: string },
  ): Promise<ConversationResult> {
    let turns = 0;

    // Hard ceiling independent of the spec, so a misbehaving runtime cannot
    // spin forever and burn the batch budget.
    for (let i = 0; i <= spec.policy.max_turns; i++) {
      const state: LeadState = await this.store.fold(base.leadId);
      const actions = await this.runtime.step(spec, state, { allowFollowUp: true });

      // Shared with the live chat loop: a simulated conversation and a real
      // one must produce identical events, or every downstream fold means
      // something different for each.
      const applied = actionsToEvents(actions, base, "simulated");
      const { events: pending, sentText, escalated, completed, qualified } = applied;

      if (pending.length > 0) await this.store.appendMany(pending);

      if (escalated) return { turns, completed: false, qualified: false, escalated: true, ghosted: false };
      if (completed) return { turns, completed: true, qualified, escalated: false, ghosted: false };
      if (sentText === null) break;

      const reply = await this.replier.reply(persona, spec, (await this.store.fold(base.leadId)).turns);
      if (reply === null) {
        return { turns, completed: false, qualified: false, escalated: false, ghosted: true };
      }

      await this.store.append({ ...base, type: "MessageReceived",
        payload: { channel: "simulated", rawText: reply } });
      turns++;
    }

    // Ran out of turns without the runtime completing.
    return { turns, completed: false, qualified: false, escalated: false, ghosted: false };
  }
}
