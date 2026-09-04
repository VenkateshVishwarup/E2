import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { offlineClient } from "@midfunnel/runtime/offline-client";
import { credentialFingerprint, describeModels, hasCredential, judgeWeakerThanJudged, loadEnvFile }
  from "@midfunnel/runtime/provider";
import { ReplayEngine } from "@midfunnel/batch/replay/engine";
import { AttributionEngine } from "@midfunnel/intelligence/attribution/engine";
import { InsightEngine } from "@midfunnel/intelligence/insights/engine";
import { Copilot } from "@midfunnel/intelligence/copilot/copilot";
import { OfflineCopilot } from "@midfunnel/intelligence/copilot/offline";
import { registerRoutes } from "./routes/replay.js";
import { registerSimulateRoutes } from "./routes/simulate.js";
import { registerIntelligenceRoutes } from "./routes/intelligence.js";
import { LiveSimulationService, chooseReplier } from "./simulation-service.js";
import type { ServerDeps } from "./deps.js";

export type { ServerDeps };
export * from "./deps.js";

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
  });
  registerRoutes(app, deps);
  registerSimulateRoutes(app, deps);
  registerIntelligenceRoutes(app, deps);
  return app;
}

/**
 * Role dispatch. One artifact, three startup modes — `web` serves the console
 * API, `runtime` steps live conversations, `batch` runs replay and simulation.
 * M1 exercises `web`; the switch exists now so adding the others is a flag.
 */
export async function main(): Promise<void> {
  loadEnvFile();
  const role = process.env.ROLE ?? "all";
  const tenantId = process.env.TENANT_ID ?? "t1";
  // Local dev default so `npm start` works without a .env; production always
  // supplies DATABASE_URL and createPool still throws when neither is set.
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_dev",
  );

  const registry = new JourneyRegistry(pool, tenantId);
  const events = new EventStore(pool, tenantId);
  // Without an OpenAI credential the model-backed extractor cannot run, so
  // fall back to the deterministic keyword extractor. It is materially weaker;
  // say so loudly rather than letting anyone mistake its output for the real
  // runtime's.
  const credentialled = hasCredential();
  console.log(`[runtime] credential: ${credentialFingerprint()}`);
  console.log(`[runtime] models: ${describeModels()}`);
  const mismatch = judgeWeakerThanJudged();
  if (mismatch) console.warn(`[runtime] WARNING: ${mismatch}`);
  if (!credentialled) {
    console.warn(
      `[runtime] no usable OPENAI_API_KEY (${credentialFingerprint()}) - using ` +
      "KeywordExtractor and the offline copilot. Results are deterministic and " +
      "read real data, but are NOT representative of the real agent. Set a " +
      "credential for genuine numbers.",
    );
  }
  const runtime = credentialled
    ? new AgentRuntime()
    : new AgentRuntime(new KeywordExtractor() as never, offlineClient());
  const replay = new ReplayEngine(events, registry, runtime);

  const simulate = new LiveSimulationService(
    pool, tenantId, registry, runtime, chooseReplier(credentialled),
  );
  const attribution = new AttributionEngine(events, registry);
  const insights = new InsightEngine(events, registry);
  const copilot = credentialled
    ? new Copilot(events, registry)
    : new OfflineCopilot(events, registry);

  if (role === "web" || role === "all") {
    const app = buildServer({
      registry, store: events, replay, simulate, attribution, insights, copilot,
    });
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`[${role}] listening on :${port}`);
  }
  if (role === "runtime") console.log("[runtime] no-op in M1 — live stepping lands in M2");
  if (role === "batch") console.log("[batch] invoked per job in M1 — see scripts/");
}
