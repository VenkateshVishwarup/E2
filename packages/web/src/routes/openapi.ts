import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import type { FastifyInstance } from "fastify";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SPEC_PATH = join(HERE, "../../../../docs/api/openapi.yaml");

/**
 * Resolved from the module's own location, not the working directory. A
 * workspace script runs with cwd inside the package, and a spec that cannot be
 * found in the way people actually start the server is a spec nobody reads.
 */
let cached: { yaml: string; json: unknown } | null = null;

export function openApiDocument(): { yaml: string; json: unknown } {
  if (!cached) {
    const yaml = readFileSync(SPEC_PATH, "utf8");
    cached = { yaml, json: parseYaml(yaml) };
  }
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
