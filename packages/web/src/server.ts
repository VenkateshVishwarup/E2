import Fastify, { type FastifyInstance } from "fastify";
import { createPool } from "@midfunnel/core/db/client";
import { EventStore } from "@midfunnel/core/events/store";
import { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { AgentRuntime } from "@midfunnel/runtime/step";
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
  const pool = createPool();

  const registry = new JourneyRegistry(pool, tenantId);
  const events = new EventStore(pool, tenantId);
  const runtime = new AgentRuntime();
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
