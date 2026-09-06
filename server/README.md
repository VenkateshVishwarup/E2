# `server/` — the source of the deployed function

`api/index.js` is **generated from `server/api-handler.ts` and committed.** Regenerate it
with `npm run build:api` whenever anything it imports changes; a test fails if you forget.

## Why a committed bundle

Vercel's Node runtime does not bundle workspace imports — it transpiles the handler and
leaves `@midfunnel/*` external, then resolves them through `node_modules`, where this
repository's packages point at TypeScript source. The lambda has no `.ts` files, so every
request died with:

```
Cannot find module '/var/task/node_modules/@midfunnel/core/src/db/client.ts'
```

`vercel dev` does not show this, because it runs where the source exists.

Generating the bundle during the build does not work either: Vercel evaluates the
`functions` glob *before* running the build command, so a function created by the build is
never detected —

```
Error: The pattern "api/**/*.js" defined in `functions` doesn't match any
Serverless Functions inside the `api` directory.
```

So the artifact has to be in the repository at clone time. The alternative is compiling
every workspace package to JavaScript and repointing its `exports` — the right answer for a
library, and more moving parts than a demo deployment needs.
