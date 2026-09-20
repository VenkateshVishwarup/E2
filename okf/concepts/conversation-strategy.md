# Conversation strategy

*Who decides what the agent does next — and what it is permitted to do either way.*

Where: `core/src/journey/moves.ts` · `runtime/src/planner.ts` · `runtime/src/guardrails.ts` ·
the branch in `runtime/src/step.ts`

## The two kinds

A journey declares one, per version, under `strategy.kind`:

| | `scripted` (default) | `open` |
|---|---|---|
| Who picks the next move | `nextField()`, in code | the model |
| What the model does | writes the wording of a question whose subject was already chosen | chooses the move, writes the message, gives a reason |
| Same conversation twice | same path | may diverge |
| Model calls per turn | 1 (extract) + 1 (question) | 1 (extract) + 1 (plan) |
| Can answer a question | no | yes, from declared facts only |

`scripted` is the default because every journey that existed before this feature
must keep behaving exactly as it did. Nothing about a spec changes until someone
sets `kind: open`.

## Why the scripted path was not enough

`step()` was a decision cascade. The model never chose anything: it wrote copy for
a question `nextField()` had already picked. So a lead who asked "what's the fee?"
got "could you tell me your timeline?" — and every objection, hedge and tangent got
the same march. The agent had no way to express *deal with what they said first*.

## The shape: propose, then dispose

```
planner (non-deterministic)  →  guardrail (deterministic)  →  actions
  ask · answer · acknowledge        admits, or overrides           ↓
  offer · close · escalate          and names the rule       MoveChosen event
```

Two separate calls, and nothing can run between them, because `admit()` is the only
path into an action. The model proposes; code decides. **Non-determinism in the
choice, determinism in what is permitted.**

The guardrail is pure and has no model in it, which is why it can be tested
exhaustively — see `runtime/test/guardrails.test.ts`. Every refusal names a rule
from a closed set (`OVERRIDE_RULES`), because "the guardrail blocked it" is not
something anyone can act on, and because a named rule can be counted.

## What an open agent does NOT get to decide

Steps 2–5 of `step()` run identically under both strategies:

1. the pinned disclosure on first contact,
2. an explicit request for a human,
3. the journey's declared `escalate_when` rules,
4. the turn budget.

These are commitments the tenant made to the lead and to whoever pays for the
tokens. An open agent chooses what to say; it does not choose whether those hold.

Scoring and routing are also shared — one `settle()` — so an open version cannot be
scored on different terms from a scripted one.

## Grounding: the tenant owns the facts

An open journey declares `knowledge:`, a map of topic to fact. The agent may state
**only** what is in it, and the text is sent **verbatim**.

For an `answer` move the planner returns *framing only* — one short sentence that is
not the fact — and the guardrail appends the declared text. So:

- the agent decides **whether** to answer; the tenant decides **what the answer says**
- `policy.never: quote_exact_fees` constrains the model's framing, not the tenant's
  own declared figure (`FIGURE` in `journey/spec.ts`, rule `answer_quoted_a_figure`)
- a question no entry covers becomes an honest deflection (`pinned.deflection`),
  never a change of subject — that is the failure this strategy exists to fix

An open journey with an empty `knowledge` block can hold a conversation and cannot
assert anything. That is the correct default for a journey nobody has briefed, and
`lintSpec` warns about it (`unanswerable_open_journey`).

## The deflection budget

`strategy.max_deflections` caps how many turns in a row the agent may spend not
collecting anything. Without it an open agent and a chatty lead talk pleasantly
forever, and every turn is billed. The streak is counted over **performed** moves,
not proposed ones: a deflection the guardrail already blocked did not happen.

## When the agent stops collecting

`objective.collect` decides it, and both strategies read the one definition
(`collectionComplete` in `runtime/src/scoring.ts`) so the same journey cannot
finish on different terms depending on who chose the path.

- `required` (default) stops as soon as the required fields are established.
  Cheapest, and what every version published before this setting existed does.
- `all` asks for every declared field, then scores.

The difference is not cosmetic. Every optional field carries weight, so a journey
whose threshold is out of reach on required evidence alone can never route anyone
hot — `lintSpec` raises `unreachable_qualification` for exactly that, and now
accounts for the policy rather than assuming the agent stops early. A real
conversation on v7 routed a lead **cold at 35** that would have scored **50** with
one more question asked, because `decision_maker` is optional and worth 15.

`all` is strictly stronger than `required`, never weaker: a field the agent has
given up on is removed from the queue, so "nothing left to ask" must not be read
as "finished" while a required field is still missing.

## A question that is not landing

`strategy.max_asks_per_field` (default 2) caps how often the agent may ask for any
one field. A lead who answers "dunno", or answers in words the extractor cannot
place, would otherwise get the same question until the turn budget ran out — which
reads as an agent that only accepts an exact phrase.

The count is over the whole conversation, not the tail, so alternating between a
stuck field and another one cannot loop either. Past the limit the guardrail
refuses the ask (`ask_repeated`) and the fallback moves to another missing field.
If the stuck field is all that is left and it is required, the conversation goes to
a human rather than closing: closing would record an inconclusive lead as if it had
run its course. The second ask of a field is rephrased to lower the bar ("roughly,
which is closest"), never repeated word for word.

The offline extractor also accepts the one word that tells a field's options apart
— "next" for `next_intake` — and refuses to guess when an answer names two options.

## Tools

An admitted `offer` returns an `invoke` action for the **caller** to perform through
the Tool Broker. `step()` never reaches the broker itself — the broker is the single
egress point and writes its own `ToolInvoked` / `AuthorizationDenied` events, and two
authorities on one decision is how an audit trail starts disagreeing with itself.

A caller that cannot reach a broker passes `toolsAvailable: false`, and the guardrail
refuses the move rather than letting the agent promise something nothing will do.
`ChatService` passes true; the simulator does not.

## Why this is measurable, not just flexible

Every decision is a `MoveChosen` event carrying `move`, `proposed`, `overridden`,
`rule`, `rationale` and `confidence`. Because `proposed` and `move` are both on the
record, the rate at which the agent is refused — and which rule refuses it — is a
fold like everything else:

- `intelligence/src/insights/detectors.ts` → `strategyFriction` reports the override
  rate, the dominant rule, and what the agent was reaching for, with a per-rule
  remedy. A guardrail that never fires is decoration; one that fires on a third of
  turns means the journey and the agent disagree about the job.
- the console interleaves each decision above the message it produced, taken from
  the order of the log rather than by pairing counts (`pairMovesToTurns`).

## Replay cannot measure a strategy change

Replay runs two versions over transcripts that **already exist**. That is right for a
change to scoring, routing or the evidence contract — the words the lead said do not
depend on any of them.

It is the wrong instrument for a strategy change. An open agent would have asked
different questions, so the lead would have said different things, and the transcript
on file is the scripted agent's. Both arms settle on the same recorded evidence and
report no difference — which reads as *the strategy changed nothing* when it means
*this method cannot tell you*.

`ReplayEngine` detects the mismatch and returns it in `Lift.caveats` rather than
letting the reader draw the wrong conclusion. Simulation is the instrument for that
comparison: it generates the conversation instead of replaying one.

## Choosing one in the console

The Journey editor has an **Agent behaviour** control — Deterministic /
Non-deterministic — which rewrites the `strategy:` block in place and adds a starter
`knowledge:` block when switching to open. The edits are surgical text operations
(`console/src/strategy-yaml.ts`), not a parse-and-serialise round trip, so the
comments in the spec survive; the lint endpoint re-parses on every keystroke.

Switching is a spec change like any other, so it obeys the normal lifecycle: bump,
publish, try it on Chat, then promote. See [version lifecycle](version-lifecycle.md).

## Trying it without a model

`npm run open` runs the same lead script through v4 and v7 side by side and prints
where they diverge and what the guardrail did. No database, no credential.

`OfflinePlanner` is a peer of `ModelPlanner`, not a stub wrapped around it, so the
runtime cannot tell them apart. It deliberately proposes `answer` with no key when
nothing matches, so the guardrail turns it into an honest deflection — the path a
real planner reaches most often.

## Related

- [Agent runtime](agent-runtime.md) — `step()` and the action contract
- [Journey spec](journey-spec.md) — where `strategy` and `knowledge` are declared
- [Tool broker](tool-broker.md) — what an `offer` runs into
- [Findings](findings.md) — `strategyFriction`
- [Counterfactual replay](replay.md) — and why it cannot see this
