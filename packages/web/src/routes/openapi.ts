import { parse as parseYaml } from "yaml";
import type { FastifyInstance } from "fastify";
import { OPENAPI_YAML } from "./openapi-content.js";

/**
 * The document is imported, not read from disk.
 *
 * It was read with `readFileSync` from a path relative to this module, which
 * works for a long-lived server and not for a bundled serverless function:
 * esbuild traces imports, so the file is simply not there and
 * `/api/openapi.json` throws ENOENT. An import is traced.
 *
 * `docs/api/openapi.yaml` remains the source — it is reviewable in a diff and
 * usable by anything that reads the repository — and a test asserts the
 * generated module matches it.
 */
let cached: { yaml: string; json: unknown } | null = null;

export function openApiDocument(): { yaml: string; json: unknown } {
  cached ??= { yaml: OPENAPI_YAML, json: parseYaml(OPENAPI_YAML) };
  return cached;
}

/**
 * Served unauthenticated: a client needs to discover the surface before it has
 * a credential, and the document describes the API rather than exposing it.
 */
export function registerSpecRoutes(app: FastifyInstance): void {
  app.get("/api/openapi.json", async () => openApiDocument().json);
  app.get("/api/openapi.yaml", async (_req, reply) => {
    reply.type("application/yaml");
    return openApiDocument().yaml;
  });
}
