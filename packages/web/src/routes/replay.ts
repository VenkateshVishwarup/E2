import type { FastifyInstance } from "fastify";
import { requiredEvidenceFields } from "@midfunnel/core/journey/spec";
import { statusFor, type ServerDeps } from "../deps.js";

/**
 * Measured, not guessed: one extraction on the reference journey cost this on
 * `terra`. Good enough to stop someone starting a job they did not intend.
 */
const USD_PER_EXTRACTION = 0.0025;

/**
 * An evenly spaced sample across the cohort, not the first N.
 *
 * Leads come back in event order, so a prefix is the oldest slice of the
 * campaign — the wrong creatives, the wrong time of day, a different mix. A
 * stride keeps the sample representative and stays deterministic, so the same
 * cohort size always yields the same leads and a number quoted on stage is the
 * number from rehearsal.
 */
function sample<T>(items: readonly T[], n: number): T[] {
  if (n >= items.length) return [...items];
  const stride = items.length / n;
  return Array.from({ length: n }, (_, i) => items[Math.floor(i * stride)]!);
}

export function registerRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // Both paths: hosts that route everything under /api to one function reach
  // the second, and a plain deployment or a load balancer reaches the first.
  app.get("/health", async () => ({ ok: true }));
  app.get("/api/health", async () => ({ ok: true }));

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
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  /**
   * What a replay would cost, before committing to it.
   *
   * Opening the Replay screen used to fire the full job on mount — 2000 leads,
   * hundreds of model calls, real money, no warning. Nothing that can spend
   * should start without someone choosing to.
   */
  app.get<{ Params: { journey: string }; Querystring: { a?: string; b?: string; n?: string } }>(
    "/api/journeys/:journey/replay-estimate",
    async (req, reply) => {
      const a = Number(req.query.a), b = Number(req.query.b);
      if (!Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "a and b must be integer versions" });
      }
      try {
        const [specA, ingested] = await Promise.all([
          deps.registry.get(req.params.journey, a),
          deps.store.query({ journey: req.params.journey, type: "LeadIngested" }),
        ]);
        const limit = Number.isInteger(Number(req.query.n)) ? Number(req.query.n) : ingested.length;
        const ids = sample(ingested, Math.max(0, limit)).map((e) => e.leadId);
        const states = await deps.store.foldMany(ids);
        const required = requiredEvidenceFields(specA);
        const extracted = states.filter((s) =>
          required.some((f) => {
            const got = s.evidence[f];
            return got === undefined || got.value === null || got.value === undefined;
          })).length;

        return {
          available: ingested.length,
          leads: ids.length,
          extracted,
          reused: ids.length - extracted,
          // Measured on a real call: one extraction on this journey.
          estimatedUsd: Math.round(extracted * USD_PER_EXTRACTION * 1e4) / 1e4,
          modelled: !deps.offline,
        };
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; leadIds?: unknown; n?: unknown } }>(
    "/api/replay",
    async (req, reply) => {
      const { journey, a, b, leadIds, n } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      if (n !== undefined && (!Number.isInteger(n) || (n as number) < 1)) {
        return reply.code(400).send({ error: "n must be a positive integer" });
      }
      const all = Array.isArray(leadIds)
        ? (leadIds as string[])
        : (await deps.store.query({ journey, type: "LeadIngested" })).map((e) => e.leadId);
      // A cohort cap is the difference between a screen you can click and a
      // screen that starts a six-figure token job. Sampled with a stride rather
      // than sliced, so a capped replay is representative of the whole cohort.
      const ids = Number.isInteger(n) ? sample(all, n as number) : all;

      try {
        return await deps.replay.replay(journey, a as number, b as number, ids);
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
