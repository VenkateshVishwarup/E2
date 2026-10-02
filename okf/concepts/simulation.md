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

## Repeats: a range, not a number

`repeats` (up to 5) runs the **same** personas through a version several times, and the
response gains `variance` (`eval/variance.ts`): the low, high and mean of every quality figure,
and how many repeats each alert fired in. Holding the cohort fixed is what isolates the
variance the model contributes; changing the seed would measure a different cohort instead.

- It is a range over a handful of runs, **not** a confidence interval, and is labelled so.
- With no model in the loop nothing can vary, and `variance.identical` says so — the console
  shows points, not a band of width zero dressed as a measurement.
- With a model, even a scripted version varies (extraction and personas are model calls), so
  the honest comparison is one version's width against another's, not band against zero.
- An alert that fires on some repeats and not others is reported as such. That is the
  agent's variance showing up as risk, and no single run can reveal it.
- The ceiling is on conversations billed: `n × repeats ≤ MAX_COHORT`. Each repeat writes
  under its own `runId`, so no repeat folds into another.

Compare still runs each arm once, so its verdict is point against point.

Related: [live conversation](live-conversation.md) · [replay](replay.md)
