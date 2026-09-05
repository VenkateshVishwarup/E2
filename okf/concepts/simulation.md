# Simulation

`packages/batch/src/simulate/` · `eval/`

Synthetic personas through a version, end to end, before a real lead meets it. Everything it
writes is `sim`-scoped and carries a `runId`.

Personas carry **ground truth**, so extraction correctness is measured against what the lead
actually was rather than against a judge's opinion. The judge scores only what a regex
cannot — naturalness, question quality, policy breaches a pattern would miss.

Both arms of a comparison meet the **same seeded personas**, which is what makes the paired
interval valid. `inconclusive` when the interval spans zero is a result, not a failure.

Thresholds are strict on correctness and policy, lenient on ghosting: a lead who stops
replying is often the lead's own choice, whereas a hallucinated fact or a policy breach is
always the agent's fault.

`MAX_COHORT` is configurable and advertised at `/api/limits`, because a serverless host
kills a function at a wall-clock ceiling and a run sized past it dies half-written.

Related: [live conversation](live-conversation.md) · [replay](replay.md)
