import type { FastifyInstance } from "fastify";
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import type { ReplayEngine } from "@midfunnel/batch/replay/engine";

export interface ServerDeps {
  registry: JourneyRegistry;
  store: EventStore;
  replay: ReplayEngine;
}

export function registerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get("/health", async () => ({ ok: true }));

  app.get<{ Params: { journey: string } }>(
    "/api/journeys/:journey/versions",
    async (req) => ({ versions: await deps.registry.list(req.params.journey) }),
  );

  app.get<{ Params: { journey: string }; Querystring: { a?: string; b?: string } }>(
    "/api/journeys/:journey/diff",
    async (req, reply) => {
      const a = Number(req.query.a);
      const b = Number(req.query.b);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "a and b must be integer versions" });
      }
      try {
        return { changes: await deps.registry.diff(req.params.journey, a, b) };
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; leadIds?: unknown } }>(
    "/api/replay",
    async (req, reply) => {
      const { journey, a, b, leadIds } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      const ids = Array.isArray(leadIds)
        ? (leadIds as string[])
        : (await deps.store.query({ journey, type: "LeadIngested" })).map((e) => e.leadId);

      try {
        return await deps.replay.replay(journey, a as number, b as number, ids);
      } catch (err) {
        return reply.code(404).send({ error: (err as Error).message });
      }
    },
  );
}
