import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { createPool, type Pool } from "@midfunnel/core/db/client";
import { migrate } from "@midfunnel/core/db/migrate";
import { EventStore } from "@midfunnel/core/events/store";
import { buildServer, routesOf } from "../src/server.js";
import { openApiDocument } from "../src/routes/openapi.js";

const URL = process.env.TEST_DATABASE_URL
  ?? "postgres://midfunnel:midfunnel@localhost:5433/midfunnel_test";

const STUB = {
  registry: { list: vi.fn(), get: vi.fn(), diff: vi.fn() } as never,
  replay: { replay: vi.fn() } as never,
  simulate: { run: vi.fn(), compare: vi.fn() } as never,
  attribution: { roll: vi.fn() } as never,
  insights: { insights: vi.fn() } as never,
  copilot: { ask: vi.fn() },
};

interface OpenApi {
  openapi: string;
  paths: Record<string, Record<string, { operationId?: string; responses: Record<string, unknown>; security?: unknown[] }>>;
  components: { schemas: Record<string, unknown>; responses: Record<string, unknown> };
}

let pool: Pool;
let app: ReturnType<typeof buildServer>;
let doc: OpenApi;

beforeAll(async () => {
  pool = createPool(URL);
  await migrate(pool);
  app = buildServer({ ...STUB, store: new EventStore(pool, "t1") });
  doc = openApiDocument().json as OpenApi;
});
afterAll(async () => { await pool.end(); });

/** Fastify writes `:journey`; OpenAPI writes `{journey}`. */
const toTemplate = (url: string) => url.replace(/:([A-Za-z_][\w]*)/g, "{$1}");
const HTTP = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);

describe("the OpenAPI document and the server cannot drift apart", () => {
  it("documents every route the server registers", () => {
    const missing = routesOf(app)
      .filter((r) => HTTP.has(r.method))
      .map((r) => ({ method: r.method.toLowerCase(), path: toTemplate(r.url) }))
      .filter((r) => !doc.paths[r.path]?.[r.method]);
    expect(missing).toEqual([]);
  });

  it("does not document a route the server does not serve", () => {
    const served = new Set(
      routesOf(app)
        .filter((r) => HTTP.has(r.method))
        .map((r) => `${r.method.toLowerCase()} ${toTemplate(r.url)}`),
    );
    const phantom: string[] = [];
    for (const [path, ops] of Object.entries(doc.paths)) {
      for (const method of Object.keys(ops)) {
        if (!served.has(`${method} ${path}`)) phantom.push(`${method} ${path}`);
      }
    }
    expect(phantom).toEqual([]);
  });
});

describe("the document follows the house rules", () => {
  const operations = () =>
    Object.entries(doc.paths).flatMap(([path, ops]) =>
      Object.entries(ops).map(([method, op]) => ({ path, method, op })));

  it("gives every operation a semantic camelCase operationId, all distinct", () => {
    const ids = operations().map(({ op }) => op.operationId);
    expect(ids.every((id) => typeof id === "string" && /^[a-z][A-Za-z0-9]*$/.test(id))).toBe(true);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("declares a success and the three error states on every operation", () => {
    for (const { path, method, op } of operations()) {
      const codes = Object.keys(op.responses);
      const where = `${method} ${path}`;
      expect(codes.some((c) => c.startsWith("2")), `${where} has no success`).toBe(true);
      expect(codes, where).toContain("500");
      // /health and the spec endpoints are deliberately open and take no input,
      // so 400 and 401 would be responses they can never produce.
      if (op.security?.length !== 0) {
        expect(codes, where).toContain("400");
        expect(codes, where).toContain("401");
      }
    }
  });

  it("routes every error response through the one shared Error schema", () => {
    for (const name of ["BadRequest", "Unauthorized", "NotFound", "InternalError"]) {
      expect(doc.components.responses[name], name).toBeDefined();
    }
    const asText = JSON.stringify(doc.paths);
    for (const [, ops] of Object.entries(doc.paths)) {
      for (const [, op] of Object.entries(ops)) {
        const err = op.responses["400"] as { $ref?: string } | undefined;
        if (err) expect(err.$ref).toMatch(/^#\/components\/responses\//);
      }
    }
    // No endpoint invents its own error shape.
    expect(asText).not.toMatch(/"errors"\s*:/);
  });

  it("defines models in components and never inline in a path", () => {
    for (const { path, method, op } of operations()) {
      for (const [code, response] of Object.entries(op.responses)) {
        const schema = (response as { content?: Record<string, { schema?: Record<string, unknown> }> })
          .content?.["application/json"]?.schema;
        if (!schema) continue;
        // The only inline schemas permitted are the two that describe an
        // arbitrary OpenAPI document, which has no fixed shape to name.
        const inline = !schema.$ref && schema.type !== undefined;
        if (inline) {
          expect(path, `${method} ${path} ${code} defines a schema inline`)
            .toMatch(/openapi/);
        }
      }
    }
  });

  it("gives every component schema an example", () => {
    const withoutExample = Object.entries(doc.components.schemas)
      .filter(([, s]) => !hasExample(s as Record<string, unknown>))
      .map(([name]) => name);
    expect(withoutExample).toEqual([]);
  });
});

/** An example on the schema, or on every one of its properties. */
function hasExample(schema: Record<string, unknown>): boolean {
  if ("example" in schema) return true;
  if (Array.isArray(schema.allOf)) {
    return schema.allOf.some((s) => hasExample(s as Record<string, unknown>));
  }
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  if (!props) return false;
  return Object.values(props).every(
    (p) => "example" in p || "$ref" in p || hasExample(p),
  );
}

describe("the document is reachable without a credential", () => {
  it("serves JSON and YAML even when a token is required", async () => {
    const guarded = buildServer({ ...STUB, store: new EventStore(pool, "t1") }, "s3cret");
    expect((await guarded.inject({ url: "/api/openapi.json" })).statusCode).toBe(200);
    expect((await guarded.inject({ url: "/api/openapi.yaml" })).statusCode).toBe(200);
    expect((await guarded.inject({ url: "/health" })).statusCode).toBe(200);
    expect((await guarded.inject({ url: "/api/journeys/x/versions" })).statusCode).toBe(401);
  });

  it("serves a document that parses as OpenAPI 3.0", async () => {
    const res = await app.inject({ url: "/api/openapi.json" });
    expect(res.json().openapi).toBe("3.0.3");
    expect(Object.keys(res.json().paths).length).toBeGreaterThan(5);
  });
});
