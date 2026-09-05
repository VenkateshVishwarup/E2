# Live conversation

`packages/web/src/chat-service.ts` · `runtime/src/persist.ts`

A session is a lead. Events are `live`-scoped with no `runId`, so a real conversation is not
a special case in this system — it is the ordinary case that was missing for a long time.

State is **folded from the log**, not held in memory, so a session survives a restart and
two clients watching it cannot disagree.

## The invariant

A live conversation must write **exactly** the events a simulated one writes, or every fold
downstream quietly means something different for live traffic than for sim. One shared
translation, `actionsToEvents`, used by both; they differ only in `env` and `runId`.

Extracting it also surfaced a bug: the simulator never emitted `HandoffCreated`, so `booked`
could never be true in a simulation regardless of routing.

## Details that matter

- The opening turn is **pinned and deterministic**, never a model call, so the AI disclosure
  a person sees first cannot be improvised.
- Cost is metered **per turn**, not per conversation: a conversation someone abandons still
  cost real money and still belongs in cost per outcome.
- Chat leads carry a `web_` prefix, so a seed script's cleanup can never delete a real
  conversation.
- A `split` routes real traffic across versions through the same allocator that splits
  simulated cohorts — live A/B needed wiring, not machinery.

Related: [version lifecycle](version-lifecycle.md) · [simulation](simulation.md)
