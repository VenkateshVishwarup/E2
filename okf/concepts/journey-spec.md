# Journey spec

`packages/core/src/journey/spec.ts`

A journey is a typed YAML contract, not a prompt. That is what makes lift attributable to a
named change, and what makes a fleet of deployments standardisable.

Blocks: `agent` (identity and enforced privileges) · `objective` · `evidence` (the contract)
· `policy` · `pinned` (deterministic text and its variables) · `scoring` · `routing` ·
`tools` · `metrics`.

## Load-bearing rules the parser enforces

- **Exactly one `otherwise` routing rule, declared last.** Routing is first-match-wins, so
  an `otherwise` anywhere else shadows everything after it.
- **A tool may not be declared without a matching privilege.**
- **Every evidence type expression must parse.**

## The lint, and why it is warnings

`lintSpec` catches journeys that cannot do what they claim: a qualifying threshold the
required evidence can never reach, scoring weights on fields that do not exist, a booking
metric in a journey whose routing never hands off, an unparseable metric, a pinned
placeholder with no default and no runtime source.

They are warnings, not errors, because a spec may legitimately rely on optional evidence a
lead volunteers — and the platform should not be the judge of that.

## Pinned text

`pinned.variables` holds the spec author's branding; the caller supplies per-conversation
values. Rendering never leaves `{{braces}}` behind. This existed only after a live
conversation put `Hi {{name}}` in front of a person — invisible until then, because nothing
had ever sent a pinned message to anyone.

Related: [version lifecycle](version-lifecycle.md) · [metric predicates](metric-predicates.md)
