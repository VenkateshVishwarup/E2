import type { FastifyInstance } from "fastify";
import { statusFor, type ServerDeps } from "../deps.js";

/**
 * One request must not be able to start a five-figure model bill — and on a
 * serverless host it must also finish inside the platform's function timeout.
 * Vercel's Hobby ceiling is 60s, which a 200-persona run does not fit, so the
 * deployment lowers this rather than letting runs die half-written.
 */
const MAX_COHORT = Number(process.env.MAX_COHORT ?? 2000);

function badCohort(n: unknown): boolean {
  return !Number.isInteger(n) || (n as number) < 1 || (n as number) > MAX_COHORT;
}

/**
 * Repeats of one cohort, reported as a range. Past a handful the range stops
 * widening in any way that changes a decision, while the bill keeps growing —
 * and a range over two hundred repeats would invite reading it as an interval.
 */
const MAX_REPEATS = 5;

export function registerSimulateRoutes(app: FastifyInstance, deps: ServerDeps): void {
  // The console reads this rather than hardcoding a size that the host will
  // then kill. A limit the client cannot see is a limit the client will exceed.
  app.get("/api/limits", async () => ({
    maxCohort: MAX_COHORT,
    maxRepeats: MAX_REPEATS,
    offline: deps.offline,
  }));

  app.post<{
    Body: { journey?: unknown; version?: unknown; n?: unknown; seed?: unknown; repeats?: unknown };
  }>(
    "/api/simulate",
    async (req, reply) => {
      const { journey, version, n, seed, repeats = 1 } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(version)) {
        return reply.code(400).send({ error: "journey (string) and version (integer) are required" });
      }
      if (badCohort(n)) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      if (!Number.isInteger(repeats) || (repeats as number) < 1 || (repeats as number) > MAX_REPEATS) {
        return reply.code(400).send({ error: `repeats must be an integer between 1 and ${MAX_REPEATS}` });
      }
      // Every repeat is a full run, so the ceiling is on the conversations
      // billed, not on the cohort a single run would have used.
      if ((n as number) * (repeats as number) > MAX_COHORT) {
        return reply.code(400).send({
          error: `n × repeats must be at most ${MAX_COHORT}; ` +
                 `${n} × ${repeats} is ${(n as number) * (repeats as number)}`,
        });
      }
      try {
        return await deps.simulate.run(
          journey, version as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
          repeats as number,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; a?: unknown; b?: unknown; n?: unknown; seed?: unknown; repeats?: unknown } }>(
    "/api/compare",
    async (req, reply) => {
      const { journey, a, b, n, seed, repeats = 1 } = req.body ?? {};
      if (typeof journey !== "string" || !Number.isInteger(a) || !Number.isInteger(b)) {
        return reply.code(400).send({ error: "journey (string), a and b (integers) are required" });
      }
      if (badCohort(n)) {
        return reply.code(400).send({ error: `n must be an integer between 1 and ${MAX_COHORT}` });
      }
      if (!Number.isInteger(repeats) || (repeats as number) < 1 || (repeats as number) > MAX_REPEATS) {
        return reply.code(400).send({ error: `repeats must be an integer between 1 and ${MAX_REPEATS}` });
      }
      // Both arms run every repeat, so the bill is twice what Simulate's cap
      // allows for the same numbers. Charge for it in the limit, not in surprise.
      const conversations = (n as number) * (repeats as number) * 2;
      if (conversations > MAX_COHORT) {
        return reply.code(400).send({
          error: `n × repeats × 2 arms must be at most ${MAX_COHORT}; ` +
                 `${n} × ${repeats} × 2 is ${conversations}`,
        });
      }
      try {
        return await deps.simulate.compare(
          journey, a as number, b as number, n as number,
          Number.isInteger(seed) ? (seed as number) : undefined,
          repeats as number,
        );
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
