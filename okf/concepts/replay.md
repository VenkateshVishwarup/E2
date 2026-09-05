# Counterfactual replay

`packages/batch/src/replay/`

Take leads that already happened and ask what a different version would have done.

## The line that must not blur

- **Observed** — `observedConversionByDecision`, measured from history. A fact.
- **Modelled** — `projectedConversions`, those rates applied to counterfactual routing. An
  estimate.

Separate fields, rendered in different colours. Blurring them is the fastest way to lose a
room.

Paired bootstrap, always: both arms are the same leads through two versions, so preserving
the pairing is what keeps the interval honest. Cohort comparisons elsewhere are **unpaired**
and use a different function.

## Cost, which is not obvious

Replay writes no events, so its spend appears in no `CostObserved` row and would be
invisible. It reports what it cost.

Three things keep that cost near zero:

1. **Leads whose evidence is already on the record are not re-extracted.** On the reference
   cohort that is 1,256 of 2,005.
2. **Both arms share one extraction** when the evidence contracts match.
3. **A capped cohort is sampled with a stride, not sliced.** A prefix is the oldest part of
   the campaign — the first 50 leads replayed 0.0% against 0.0% where a 200-lead stride
   sample gives 1.5% against 5.5%.

Related: [agent runtime](agent-runtime.md) · [event spine](event-spine.md)
