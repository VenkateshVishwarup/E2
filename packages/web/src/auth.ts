import { timingSafeEqual } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * Paths that must answer without a credential: a load balancer probing health
 * and a client discovering the API surface. Everything else is guarded.
 */
const OPEN = new Set(["/health", "/api/openapi.json", "/api/openapi.yaml"]);

/**
 * Bearer-token guard, enabled by setting `API_TOKEN`.
 *
 * Opt-in rather than always-on because the demo runs on a laptop against a
 * local Postgres, and a token there protects nothing while making the console
 * harder to start. But the guard is real code on a real hook, so the enterprise
 * answer is "set one variable", not "we would add authentication".
 *
 * Comparison is constant-time. A plain `===` on a secret leaks its length and
 * its matching prefix through timing, which is the kind of detail that turns a
 * security review into a longer conversation than it needs to be.
 */
export function registerAuth(app: FastifyInstance, token: string | null): void {
  if (!token) return;
  const expected = Buffer.from(token, "utf8");

  app.addHook("onRequest", async (req: FastifyRequest, reply: FastifyReply) => {
    if (OPEN.has(req.url.split("?")[0]!)) return;

    const header = req.headers.authorization ?? "";
    const match = /^Bearer\s+(.+)$/i.exec(header.trim());
    if (!match || !constantTimeEquals(expected, match[1]!)) {
      // No hint about which half was wrong: "unknown token" and "missing
      // header" are the same answer to anyone probing.
      return reply.code(401).send({ error: "a valid Bearer token is required" });
    }
  });
}

function constantTimeEquals(expected: Buffer, supplied: string): boolean {
  const given = Buffer.from(supplied, "utf8");
  // timingSafeEqual throws on a length mismatch, which would itself be a
  // timing signal. Compare against a padded copy so every path does the work.
  const padded = Buffer.alloc(expected.length);
  given.copy(padded, 0, 0, Math.min(given.length, expected.length));
  return timingSafeEqual(expected, padded) && given.length === expected.length;
}
