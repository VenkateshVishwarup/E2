# Agent runtime

`packages/runtime/src/step.ts`

```ts
step(spec, state, opts) -> Action[]
```

The entire contract. Pure with respect to the log: it reads a folded `LeadState` and
returns *intended* actions. The caller persists them, which is what lets replay, simulation
and live traffic share one runtime — and what makes the runtime replaceable.

Actions: `send` · `extract` · `score` · `route` · `escalate` · `complete`.

## Order of decisions

1. First contact — pinned, deterministic, **never a model call**
2. Explicit human request short-circuits everything
3. Extract, then merge over what is known
4. Declared escalation triggers, on evidence and sentiment
5. Turn budget
6. Required evidence complete ⇒ score, route, finish
7. Otherwise ask for the next missing field

Field ordering: required before optional, and a `sensitive` field is never asked while
nothing at all is established — you do not open with money.

## Options that change the shape

- `allowFollowUp: false` — replay, where the transcript is finished and asking would burn a
  call for nothing
- `reuseEvidence: true` — replay again, running both arms against one extraction. Halving
  the calls is the lesser reason: extracting per arm injects model variance into a
  comparison whose purpose is to isolate the version change

Related: [evidence extraction](evidence-extraction.md) · [replay](replay.md)
