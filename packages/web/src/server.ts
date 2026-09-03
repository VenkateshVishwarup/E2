import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
import { KeywordExtractor } from "@midfunnel/runtime/keyword-extractor";
import { ReplayEngine } from "@midfunnel/batch/replay/engine";
import { registerRoutes, type ServerDeps } from "./routes/replay.js";

export type { ServerDeps };

export function buildServer(deps: ServerDeps): FastifyInstance {
  const app = Fastify({ logger: false });
  app.addHook("onRequest", async (_req, reply) => {
    reply.header("access-control-allow-origin", "*");
  });
  registerRoutes(app, deps);
  return app;
}

/**
 * Role dispatch. One artifact, three startup modes — `web` serves the console
 * API, `runtime` steps live conversations, `batch` runs replay and simulation.
 * M1 exercises `web`; the switch exists now so adding the others is a flag.
 */
export async function main(): Promise<void> {
  const role = process.env.ROLE ?? "all";
  const tenantId = process.env.TENANT_ID ?? "t1";
  // Local dev default so `npm start` works without a .env; production always
  // supplies DATABASE_URL and createPool still throws when neither is set.
  const pool = createPool(
    process.env.DATABASE_URL ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_dev",
  );

  const registry = new JourneyRegistry(pool, tenantId);
  const events = new EventStore(pool, tenantId);
  // Without an Anthropic credential the model-backed extractor cannot run, so
  // fall back to the deterministic keyword extractor. It is materially weaker;
  // say so loudly rather than letting anyone mistake its output for the real
  // runtime's.
  const hasCredential = Boolean(process.env.ANTHROPIC_API_KEY ?? process.env.ANTHROPIC_AUTH_TOKEN);
  if (!hasCredential) {
    console.warn(
      "[runtime] no ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN found - " +
      "using KeywordExtractor. Results are deterministic but NOT representative " +
      "of the real agent. Set a credential for genuine replay numbers.",
    );
  }
  const runtime = hasCredential
    ? new AgentRuntime()
    : new AgentRuntime(new KeywordExtractor() as never, {} as never);
  const replay = new ReplayEngine(events, registry, runtime);

  if (role === "web" || role === "all") {
    const app = buildServer({ registry, store: events, replay });
    const port = Number(process.env.PORT ?? 3000);
    await app.listen({ port, host: "0.0.0.0" });
    console.log(`[${role}] listening on :${port}`);
  }
  if (role === "runtime") console.log("[runtime] no-op in M1 — live stepping lands in M2");
  if (role === "batch") console.log("[batch] invoked per job in M1 — see scripts/");
}
