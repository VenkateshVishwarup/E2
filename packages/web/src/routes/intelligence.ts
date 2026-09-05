import type { FastifyInstance } from "fastify";
import { lintSpec, parseSpec } from "@midfunnel/core/journey/spec";
import { statusFor, type ServerDeps } from "../deps.js";

/** A question long enough to be an essay is a paste, not a question. */
const MAX_QUESTION = 500;

/** A journey spec is a page of YAML, not a document. */
const MAX_SPEC = 40_000;

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

  app.get<{ Params: { journey: string }; Querystring: { version?: string } }>(
    "/api/journeys/:journey/source",
    async (req, reply) => {
      const raw = req.query.version;
      if (raw !== undefined && !/^\d+$/.test(raw)) {
        return reply.code(400).send({ error: "version must be a positive integer" });
      }
      try {
        const version = raw === undefined
          ? (await deps.registry.latest(req.params.journey)).version
          : Number(raw);
        return {
          journey: req.params.journey, version,
          yaml: await deps.registry.getSource(req.params.journey, version),
        };
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  // Lint arbitrary YAML that has not been published. This is what lets the
  // editor show problems while someone types rather than after they publish.
  app.post<{ Body: { yaml?: unknown } }>(
    "/api/journeys/lint",
    async (req, reply) => {
      const yaml = req.body?.yaml;
      if (typeof yaml !== "string" || yaml.trim().length === 0) {
        return reply.code(400).send({ error: "yaml (non-empty string) is required" });
      }
      if (yaml.length > MAX_SPEC) {
        return reply.code(400).send({ error: `yaml must be at most ${MAX_SPEC} characters` });
      }
      try {
        const spec = parseSpec(yaml);
        return { valid: true, journey: spec.journey, version: spec.version, warnings: lintSpec(spec) };
      } catch (err) {
        // A spec that does not parse is a lint result, not a server error: the
        // editor needs the message to show, not a failed request.
        return { valid: false, error: (err as Error).message, warnings: [] };
      }
    },
  );

  app.post<{ Body: { yaml?: unknown } }>(
    "/api/journeys/publish",
    async (req, reply) => {
      const yaml = req.body?.yaml;
      if (typeof yaml !== "string" || yaml.trim().length === 0) {
        return reply.code(400).send({ error: "yaml (non-empty string) is required" });
      }
      if (yaml.length > MAX_SPEC) {
        return reply.code(400).send({ error: `yaml must be at most ${MAX_SPEC} characters` });
      }
      let spec;
      try {
        spec = parseSpec(yaml);
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
      try {
        const published = await deps.registry.publish(yaml);
        // Publishing IS deployment: chat serves this version from here on.
        return {
          journey: published.journey, version: published.version,
          warnings: lintSpec(published),
        };
      } catch (err) {
        // "already published" is the caller's mistake, not an upstream failure.
        const conflict = /already published/i.test((err as Error).message);
        return reply.code(conflict ? 409 : statusFor(err)).send({ error: (err as Error).message });
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
