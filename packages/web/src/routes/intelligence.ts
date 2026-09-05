import type { FastifyInstance } from "fastify";
import { lintSpec } from "@midfunnel/core/journey/spec";
import { statusFor, type ServerDeps } from "../deps.js";

/** A question long enough to be an essay is a paste, not a question. */
const MAX_QUESTION = 500;

export function registerIntelligenceRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.get<{ Params: { journey: string }; Querystring: { currency?: string } }>(
    "/api/journeys/:journey/roi",
    async (req, reply) => {
      const currency = req.query.currency ?? "INR";
      if (!/^[A-Z]{3}$/.test(currency)) {
        return reply.code(400).send({ error: "currency must be a three-letter ISO code" });
      }
      try {
        return await deps.attribution.roll(req.params.journey, currency);
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { journey: string }; Querystring: { conversion?: string; qualified?: string } }>(
    "/api/journeys/:journey/insights",
    async (req, reply) => {
      try {
        return await deps.insights.insights(req.params.journey, {
          ...(req.query.conversion ? { conversion: req.query.conversion } : {}),
          ...(req.query.qualified ? { qualified: req.query.qualified } : {}),
        });
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { journey: string }; Querystring: { version?: string } }>(
    "/api/journeys/:journey/lint",
    async (req, reply) => {
      const raw = req.query.version;
      if (raw !== undefined && !/^\d+$/.test(raw)) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      try {
        const spec = raw === undefined
          ? await deps.registry.latest(req.params.journey)
          : await deps.registry.get(req.params.journey, Number(raw));
        return { journey: spec.journey, version: spec.version, warnings: lintSpec(spec) };
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Body: { journey?: unknown; question?: unknown } }>(
    "/api/copilot/ask",
    async (req, reply) => {
      const { journey, question } = req.body ?? {};
      if (typeof journey !== "string" || journey.length === 0) {
        return reply.code(400).send({ error: "journey (string) is required" });
      }
      if (typeof question !== "string" || question.trim().length === 0) {
        return reply.code(400).send({ error: "question (non-empty string) is required" });
      }
      if (question.length > MAX_QUESTION) {
        return reply.code(400).send({ error: `question must be at most ${MAX_QUESTION} characters` });
      }
      try {
        return await deps.copilot.ask(journey, question.trim());
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
