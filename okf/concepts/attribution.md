# Attribution

`packages/intelligence/src/attribution/`

ROI as a fold over the same log every other screen reads, so `qualified_lead` here and
`qualified_lead` on the scoreboard cannot disagree — they are the same predicate.

Hierarchy: campaign → creative → journey version. A lead is attributed to the version that
produced its **routing decision**, falling back to the one it was ingested under.

## Three decisions worth knowing

- **Each lead is evaluated under the metric definitions of the version it ran under**, not
  the latest spec. Otherwise editing `conversion:` silently rewrites last quarter — the one
  thing an append-only log exists to prevent. Definition drift across versions present in
  the data is reported as a caveat.
- **Media spend is allocated, evenly, and the method travels in the payload.** Ad platforms
  report per campaign per day; the spine needs a lead on every event. A customer disputing
  cost-per-enrolment is entitled to see which assumption produced the number.
- **Model spend is metered from real token usage** and converted at write time with the rate
  recorded in the event, so a later FX change cannot rewrite historical ROI.

`costPer` is **null** when the count is zero — an undefined ratio, not an infinite one.

Related: [metric predicates](metric-predicates.md) · [event spine](event-spine.md)
