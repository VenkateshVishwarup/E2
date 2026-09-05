# E2 — Operational Knowledge File

The canonical map of this codebase. Read this before the source: it says what the
concepts are and where each one lives, so a change lands in the right place.

## The one idea

**There is a single append-only `events` table, and everything else is a fold over it.**
Replay, the A/B scoreboard, ROI, findings and the copilot all read the same log through
the same declared predicates, so they cannot disagree with one another. There is no
separate analytics pipeline to fall out of sync, and nothing is precomputed.

A second idea explains most of the response shapes: the log records **observable facts
only**. There is deliberately no `Converted` event, because "converted" means different
things to marketing, sales and finance. Each tenant declares named metrics as predicates
over the facts, so the platform never picks a definition on anyone's behalf.

## Concepts

| Concept | What it is | Where |
|---|---|---|
| [Event spine](concepts/event-spine.md) | The append-only log and its two isolation axes | `core/src/events/` |
| [Journey spec](concepts/journey-spec.md) | A typed YAML contract, not a prompt | `core/src/journey/spec.ts` |
| [Version lifecycle](concepts/version-lifecycle.md) | Publish, try, promote, roll back | `core/src/journey/registry.ts` |
| [Metric predicates](concepts/metric-predicates.md) | Tenant-declared metrics over events | `core/src/metrics/predicate.ts` |
| [Agent runtime](concepts/agent-runtime.md) | `step()` and the action contract | `runtime/src/step.ts` |
| [Evidence extraction](concepts/evidence-extraction.md) | The contract as a JSON Schema | `runtime/src/extractor.ts` |
| [Tool broker](concepts/tool-broker.md) | The agent as an enforced principal | `runtime/src/broker.ts` |
| [Counterfactual replay](concepts/replay.md) | Observed versus modelled, kept apart | `batch/src/replay/` |
| [Simulation](concepts/simulation.md) | Personas, scorecards, thresholds | `batch/src/simulate/` |
| [Attribution](concepts/attribution.md) | ROI as a fold, with its assumptions | `intelligence/src/attribution/` |
| [Findings](concepts/findings.md) | Seven detectors, and their significance bar | `intelligence/src/insights/` |
| [Copilot](concepts/copilot.md) | Tools over folds, and the diff gate | `intelligence/src/copilot/` |
| [Live conversation](concepts/live-conversation.md) | Chat, and why it shares the simulator's writes | `web/src/chat-service.ts` |

## Invariants

Break one of these and something downstream silently means a different thing.

1. **A live conversation and a simulated one write identical events.** One shared
   translation in `runtime/src/persist.ts`; they differ only in `env` and `runId`.
2. **Specs are read from `yaml_source`, never the JSONB column.** Postgres re-sorts JSONB
   keys; routing is first-match-wins, so a round trip reorders the rules and misroutes.
3. **Every event carries an `agent_id`.** The agent is a principal, and privileges are
   enforced at the broker, not declared in prose.
4. **Observed and modelled numbers live in separate fields.** Blurring them is the fastest
   way to lose a room.
5. **Comparisons carry an interval, and paired versus unpaired is chosen deliberately.**
   Replay is paired (same leads, two versions); cohort comparisons are not.
6. **`env` is in the WHERE clause, not an optional filter.** Simulation cannot leak into a
   live-scoped read by someone forgetting a flag.
7. **Publishing is not shipping.** Publishing makes a version exist; promoting makes it
   the one real traffic meets.

## Layout

One deployable artifact, five packages, started by role (`ROLE=web|runtime|batch|all`).

```
core          event store · journey registry · spec · metric predicates · bootstrap stats
runtime       step() · extraction · scoring · routing · broker · model profiles · metering
batch         import · replay · simulation · eval harness · traffic allocator
intelligence  attribution · findings · copilot
web           Fastify API, live chat loop        console  React UI
```

`core` depends on nothing. `runtime` depends on `core`. `batch` and `intelligence` are
peers over `core` + `runtime`; neither depends on the other. `web` composes all four.
