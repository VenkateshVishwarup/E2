/** Regenerates packages/console/src/okf-content.ts from okf/. */
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
