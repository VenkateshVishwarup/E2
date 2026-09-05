# Event spine

`packages/core/src/events/`

One append-only table. Every read model in the product is a fold over it, which is why no
two screens can disagree about a number.

## Shape

Thirteen event types, all **observable facts**: `LeadIngested`, `MessageSent`,
`MessageReceived`, `EvidenceExtracted`, `PolicyEvaluated`, `ToolInvoked`,
`AuthorizationDenied`, `Scored`, `Routed`, `HandoffCreated`, `NurtureScheduled`,
`OutcomeObserved`, `CostObserved`.

There is deliberately **no `Converted` event**. See [metric predicates](metric-predicates.md).

## Two isolation axes

- **`env`** — `live` or `sim`. Enforced in the query builder's WHERE clause, never as an
  optional filter, so a forgotten flag cannot leak simulated events into a live read.
- **`run_id`** — set for simulated runs, null for live. A CHECK constraint enforces
  sim ⇒ runId and live ⇒ !runId, and `validate()` repeats it in code so the error is
  readable rather than a raw constraint violation.

## Gotchas that cost time

- **`appendMany` chunks at 1500.** The wire protocol counts bind parameters in an Int16;
  at ten per event the count wraps negative past 32,767 and the server rejects the message
  with an error naming neither cause nor limit. Any real import crosses this.
- **`foldMany` exists for cohorts.** Folding lead by lead issues one round trip each, which
  dominated replay's wall time before a single model call was made.
- **Money is integer minor units everywhere.** Never a float. `int8` is parsed to a number
  at the driver, exact below 2^53.

Related: [live conversation](live-conversation.md) · [attribution](attribution.md)
