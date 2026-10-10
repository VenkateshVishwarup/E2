import type { FastifyInstance } from "fastify";
import { isChannel, type Channel } from "@midfunnel/core/channels";
import { describeChannels } from "../channel-delivery.js";
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
      const { journey, version, split, source, campaignId, creativeId,
              channel, address, consentChannels } = req.body ?? {};
      if (typeof journey !== "string" || journey.length === 0) {
        return reply.code(400).send({ error: "journey (string) is required" });
      }
      if (channel !== undefined && !isChannel(channel)) {
        return reply.code(400).send({ error: "channel must be one of web, whatsapp, voice" });
      }
      if (address !== undefined && typeof address !== "string") {
        return reply.code(400).send({ error: "address must be a string" });
      }
      if (consentChannels !== undefined
          && (!Array.isArray(consentChannels) || !consentChannels.every(isChannel))) {
        return reply.code(400).send({ error: "consentChannels must be an array of channels" });
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
          ...(isChannel(channel) ? { channel } : {}),
          ...(typeof address === "string" ? { address } : {}),
          ...(Array.isArray(consentChannels) ? { consentChannels: consentChannels as Channel[] } : {}),
        });
      } catch (err) {
        return reply.code(statusFor(err)).send({ error: (err as Error).message });
      }
    },
  );

  /** What each channel can actually do in this deployment. */
  app.get("/api/channels", async () => ({ channels: describeChannels() }));

  /**
   * A message arriving from a channel the lead started on.
   *
   * Addressed by phone number rather than session id, because that is all an
   * inbound WhatsApp message carries. An unknown address opens a conversation;
   * a known one continues the conversation it belongs to — found through the
   * log, since the reply may be handled by a different process from the one
   * that asked the question.
   *
   * An inbound message IS consent to reply on that channel, and on no other.
   */
  app.post<{ Params: { channel: string }; Body: Record<string, unknown> }>(
    "/api/channels/:channel/inbound",
    async (req, reply) => {
      const channel = req.params.channel;
      if (!isChannel(channel) || channel === "web") {
        return reply.code(400).send({ error: "channel must be one of whatsapp, voice" });
      }
      const { from, text, journey } = req.body ?? {};
      if (typeof from !== "string" || from.trim().length === 0) {
        return reply.code(400).send({ error: "from (non-empty string) is required" });
      }
      if (typeof text !== "string" || text.trim().length === 0) {
        return reply.code(400).send({ error: "text (non-empty string) is required" });
      }
      if (text.length > MAX_MESSAGE) {
        return reply.code(400).send({ error: `text must be at most ${MAX_MESSAGE} characters` });
      }

      try {
        const existing = await deps.chat.findByAddress(channel, from.trim());
        if (existing) return await deps.chat.send(existing, text);

        if (typeof journey !== "string" || journey.length === 0) {
          return reply.code(400).send({
            error: "journey (string) is required to open a conversation with a new address",
          });
        }
        // Opening sends the disclosure. The lead's own message is then delivered
        // into that conversation, so nothing they said is dropped on the way in.
        const opened = await deps.chat.start({
          journey, channel, address: from.trim(),
          consentChannels: [channel], source: `${channel}_inbound`,
        });
        return await deps.chat.send(opened.state.leadId, text);
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
