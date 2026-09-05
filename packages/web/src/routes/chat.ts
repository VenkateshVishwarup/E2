import type { FastifyInstance } from "fastify";
import { statusFor, type ServerDeps } from "../deps.js";

/** A single chat turn. Longer than this is a paste, not a message. */
const MAX_MESSAGE = 2000;

function badSplit(split: unknown): string | null {
  if (split === undefined) return null;
  if (typeof split !== "object" || split === null || Array.isArray(split)) {
    return "split must be an object of version to percentage";
  }
  const entries = Object.entries(split as Record<string, unknown>);
  if (entries.length < 2) return "split needs at least two versions";
  let total = 0;
  for (const [version, weight] of entries) {
    if (!/^\d+$/.test(version)) return `split key "${version}" is not a version number`;
    if (typeof weight !== "number" || !Number.isFinite(weight) || weight < 0) {
      return `split weight for v${version} must be a non-negative number`;
    }
    total += weight;
  }
  return total === 100 ? null : `split must sum to 100, got ${total}`;
}

export function registerChatRoutes(app: FastifyInstance, deps: ServerDeps): void {
  app.post<{ Body: Record<string, unknown> }>(
    "/api/chat/sessions",
    async (req, reply) => {
      const { journey, version, split, source, campaignId, creativeId } = req.body ?? {};
      if (typeof journey !== "string" || journey.length === 0) {
        return reply.code(400).send({ error: "journey (string) is required" });
      }
      if (version !== undefined && !Number.isInteger(version)) {
        return reply.code(400).send({ error: "version must be an integer" });
      }
      const splitError = badSplit(split);
      if (splitError) return reply.code(400).send({ error: splitError });

      try {
        return await deps.chat.start({
          journey,
          ...(Number.isInteger(version) ? { version: version as number } : {}),
          ...(split ? { split: split as Record<string, number> } : {}),
          ...(typeof source === "string" ? { source } : {}),
          ...(typeof campaignId === "string" ? { campaignId } : {}),
          ...(typeof creativeId === "string" ? { creativeId } : {}),
        });
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.post<{ Params: { leadId: string }; Body: { text?: unknown } }>(
    "/api/chat/sessions/:leadId/messages",
    async (req, reply) => {
      const text = req.body?.text;
      if (typeof text !== "string" || text.trim().length === 0) {
        return reply.code(400).send({ error: "text (non-empty string) is required" });
      }
      if (text.length > MAX_MESSAGE) {
        return reply.code(400).send({ error: `text must be at most ${MAX_MESSAGE} characters` });
      }
      try {
        return await deps.chat.send(req.params.leadId, text.trim());
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  app.get<{ Params: { leadId: string } }>(
    "/api/chat/sessions/:leadId",
    async (req, reply) => {
      try {
        return await deps.chat.state(req.params.leadId);
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );
}
