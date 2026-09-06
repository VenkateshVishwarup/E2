/**
 * Regenerates the two modules that carry file content into a bundle:
 * the console's copy of `okf/`, and the API's copy of the OpenAPI document.
 *
 * Both exist because a serverless function is bundled by esbuild, which traces
 * imports and cannot see a `readFileSync` of a path outside the bundle. The
 * files stay authoritative on disk — reviewable in a diff — and a test asserts
 * the generated modules match them.
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const docs: Record<string, string> = { index: readFileSync("okf/index.md", "utf8") };
for (const f of readdirSync("okf/concepts").filter((n) => n.endsWith(".md")).sort()) {
  docs[f.replace(/\.md$/, "")] = readFileSync(join("okf/concepts", f), "utf8");
}

writeFileSync("packages/console/src/okf-content.ts",
  `/**
 * Generated from \`okf/\` by \`npm run okf:bundle\`. Do not edit here.
 *
 * The knowledge file lives on disk so it is reviewable in a diff and usable
 * by anything that reads the repo; this module exists so the console can
 * show it without a fetch and without a second copy to keep in step.
 */
export const OKF: Record<string, string> = ${JSON.stringify(docs, null, 2)};
`);
console.log(`bundled ${Object.keys(docs).length} documents`);

writeFileSync("packages/web/src/routes/openapi-content.ts",
  `/**
 * Generated from \`docs/api/openapi.yaml\` by \`npm run okf:bundle\`. Do not edit here.
 *
 * Bundled rather than read from disk because a serverless function is packed by
 * esbuild, which traces imports and cannot see a runtime \`readFileSync\`. On
 * Vercel the file simply would not be there, and \`/api/openapi.json\` would
 * throw ENOENT — a failure that only appears in production.
 */
export const OPENAPI_YAML = ${JSON.stringify(readFileSync("docs/api/openapi.yaml", "utf8"))};
`);
console.log("bundled the OpenAPI document");
