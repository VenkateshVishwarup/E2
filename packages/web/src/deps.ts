import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { ReplayEngine } from "@midfunnel/batch/replay/engine";
import type { RunSummary } from "@midfunnel/batch/simulate/runner";
import type { Alert, RunQuality } from "@midfunnel/batch/eval/alerts";
import type { VarianceReport } from "@midfunnel/batch/eval/variance";
import type { Scoreboard } from "@midfunnel/batch/experiment/compare";
import type { AttributionEngine } from "@midfunnel/intelligence/attribution/engine";
import type { InsightEngine } from "@midfunnel/intelligence/insights/engine";
import type { Answer } from "@midfunnel/intelligence/copilot/types";
import type { Channel } from "@midfunnel/core/channels";
import type { ChatReply, ChatState, StartSession } from "./chat-service.js";

export interface SimulationResult {
  /** The first repeat's, so a caller that ignores `variance` reads one run. */
  summary: RunSummary;
  quality: RunQuality;
  alerts: Alert[];
  /** Present only when the cohort was run more than once. */
  variance?: VarianceReport;
}

export interface SimulationService {
  run(journey: string, version: number, n: number, seed?: number, repeats?: number):
    Promise<SimulationResult>;
  compare(journey: string, va: number, vb: number, n: number, seed?: number): Promise<Scoreboard>;
}

/** Both the model-backed Copilot and the OfflineCopilot satisfy this. */
export interface CopilotService {
  ask(journey: string, question: string): Promise<Answer>;
}

export interface ChatSessions {
  start(opts: StartSession): Promise<ChatReply>;
  send(leadId: string, text: string): Promise<ChatReply>;
  state(leadId: string): Promise<ChatState>;
  /** The conversation already running at an address, for an inbound message. */
  findByAddress(channel: Channel, address: string): Promise<string | null>;
}

export interface ServerDeps {
  registry: JourneyRegistry;
  store: EventStore;
  replay: ReplayEngine;
  simulate: SimulationService;
  attribution: AttributionEngine;
  insights: InsightEngine;
  copilot: CopilotService;
  chat: ChatSessions;
  /** True when no model credential is configured, so nothing can cost money. */
  offline: boolean;
}

/**
 * A missing journey is a 404; anything else (a failing model call, a database
 * error) is an upstream failure. Collapsing both into 404 hides the cause.
 */
export function statusFor(err: unknown): number {
  return /not found/i.test((err as Error).message) ? 404 : 502;
}
