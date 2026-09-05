# Copilot

`packages/intelligence/src/copilot/`

`ask(question) -> Answer + View? + ProposedDiff?`, over the same folds the console screens
read — so the copilot and the screens cannot disagree about a number.

## Tools, never raw SQL

SQL from a model is both an injection surface and a hallucination surface. The tools are
`roi`, `insights`, `cohort`, `read_spec`, `propose_diff`. The journey is **fixed by the
caller**, never chosen by the model: a copilot that can retarget its own scope is a tenancy
hole waiting to happen.

## The gate

`propose_diff` **parses, lints and diffs a proposal before returning it**. A failure goes
back to the model as an error to correct, never out to a human as a suggestion they discover
is broken. Six ways to fail it, each tested.

## Views are descriptors

A closed set — `bar`, `table`, `stat`. The model never emits markup: HTML from a model into
the console DOM is an XSS hole, whereas choosing a chart type from three options is the
conversational-rendering thesis without one.

## A trap worth remembering

Echo back only the four fields the API defines when returning a tool call. The SDK
decorates each with `parsed_arguments`, and sending that back is rejected — which is the
second turn of *every* tool-using conversation, so it failed 100% of the time against the
real model while every offline test passed.

Related: [findings](findings.md) · [attribution](attribution.md)
