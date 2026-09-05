# Metric predicates

`packages/core/src/metrics/predicate.ts`

`metrics:` is a **different language** from `routing.when`, and conflating them is the trap
this module exists to avoid. A routing predicate asks about one lead's *score*; a metric
asks about one lead's *event history*.

```
metric    := aggregate | boolean
aggregate := ("sum"|"count"|"avg") "(" Type ["." field] ["where" cond] ")"
boolean   := Type "exists" | Type "." field OP literal
           | Type "." field "in" "[" literal, … "]" | boolean ("AND"|"OR") boolean
```

## Two kinds, and why it matters

A **boolean** metric aggregates as a *count of leads*; an **aggregate** metric as a *sum
over leads*. One evaluator returning `number` for both would let `qualified_lead`
contribute rupees to revenue-per-lead, and nobody would see it.

## An unknown event type is a parse error

`Routed.desicion` evaluating quietly to false would under-report conversion for ever and
look like poor performance rather than a typo. `lintSpec` flags it at publish.

No `eval`, for the same reason as the routing evaluator: specs are authored data, and
running them as code would put remote code execution in the read path.

Related: [event spine](event-spine.md) · [attribution](attribution.md)
