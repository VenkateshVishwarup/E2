import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { ReplayEngine } from "@midfunnel/batch/replay/engine";
import type { RunSummary } from "@midfunnel/batch/simulate/runner";
import type { Alert, RunQuality } from "@midfunnel/batch/eval/alerts";
import type { Scoreboard } from "@midfunnel/batch/experiment/compare";

export interface SimulationResult {
  summary: RunSummary;
  quality: RunQuality;
  alerts: Alert[];
}

export interface SimulationService {
  run(journey: string, version: number, n: number, seed?: number): Promise<SimulationResult>;
  compare(journey: string, va: number, vb: number, n: number, seed?: number): Promise<Scoreboard>;
}

export interface ServerDeps {
  registry: JourneyRegistry;
  store: EventStore;
  replay: ReplayEngine;
  simulate: SimulationService;
}

/**
 * A missing journey is a 404; anything else (a failing model call, a database
 * error) is an upstream failure. Collapsing both into 404 hides the cause.
 */
export function statusFor(err: unknown): number {
  return /not found/i.test((err as Error).message) ? 404 : 502;
}
