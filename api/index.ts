import type { IncomingMessage, ServerResponse } from "node:http";
import { createPool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { offlineClient } from "@midfunnel/runtime/offline-client";
import { hasCredential } from "@midfunnel/runtime/provider";
import { ReplayEngine } from "@midfunnel/batch/replay/engine";
import { AttributionEngine } from "@midfunnel/intelligence/attribution/engine";
import { InsightEngine } from "@midfunnel/intelligence/insights/engine";
import { Copilot } from "@midfunnel/intelligence/copilot/copilot";
import { OfflineCopilot } from "@midfunnel/intelligence/copilot/offline";
import { buildServer } from "@midfunnel/web/server";
import { LiveSimulationService, chooseReplier } from "@midfunnel/web/simulation-service";
import { ChatService } from "@midfunnel/web/chat-service";
import type { FastifyInstance } from "fastify";

/**
 * Vercel entry point.
 *
 * A serverless function is created per request but the container is reused, so
 * the app and the connection pool are built once per warm instance and kept on
 * module scope. Building them per request would open a new pool on every call
 * and exhaust the database's connection limit within a minute of real traffic.
 */
let ready: Promise<FastifyInstance> | null = null;

async function build(): Promise<FastifyInstance> {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set");

  // Serverless: many short-lived instances, each holding few connections.
  // The pooled endpoint (Neon's `-pooler` host) does the real multiplexing.
  const pool = createPool(url, { max: 2, idleTimeoutMillis: 10_000 });
  const tenantId = process.env.TENANT_ID ?? "t1";

  const registry = new JourneyRegistry(pool, tenantId);
  const events = new EventStore(pool, tenantId);
  const credentialled = hasCredential();

  const runtime = credentialled
    ? new AgentRuntime()
    : new AgentRuntime(new KeywordExtractor() as never, offlineClient());

  const fx = {
    currency: process.env.REPORTING_CURRENCY ?? "INR",
    perUsd: Number(process.env.FX_MINOR_PER_USD ?? 8300),
  };

  const app = buildServer({
    registry,
    store: events,
    replay: new ReplayEngine(events, registry, runtime),
    simulate: new LiveSimulationService(
      pool, tenantId, registry, runtime, chooseReplier(credentialled)),
    attribution: new AttributionEngine(events, registry),
    insights: new InsightEngine(events, registry),
    copilot: credentialled
      ? new Copilot(events, registry)
      : new OfflineCopilot(events, registry),
    chat: new ChatService(events, registry, runtime, fx, !credentialled),
    offline: !credentialled,
  }, process.env.API_TOKEN ?? null);

  // `ready()` returns a PromiseLike, not a Promise — awaiting it is both
  // correct and clearer than returning something typed as more than it is.
  await app.ready();
  return app;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  ready ??= build();
  const app = await ready;
  // Hand the raw request to Fastify's own server. Fastify has no Vercel
  // adapter; this is the documented way to drive it from any Node handler.
  app.server.emit("request", req, res);
}
