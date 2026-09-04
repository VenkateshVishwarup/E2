import type { FastifyInstance } from "fastify";
import { statusFor, type ServerDeps } from "../deps.js";

/** One request must not be able to start a five-figure model bill. */
const MAX_COHORT = 2000;

function badCohort(n: unknown): boolean {
  return !Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_COHORT;
}

export function registerSimulateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: { journey?: unknown; version?: unknown; n?: unknown; seed?: unknown } }>(
    "/api/simulate",
    async (req, reply) => {
      const { journey, version, n, seed } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(version)) {
        return reply.code(400).send({ error: "journey (string) and version (integer) are required" });
      }
      if (badCohort(n)) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      try {
        return await deps.simulate.run(
          journey, version as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; n?: unknown; seed?: unknown } }>(
    "/api/compare",
    async (req, reply) => {
      const { journey, a, b, n, seed } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      if (badCohort(n)) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      try {
        return await deps.simulate.compare(
          journey, a as number, b as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
