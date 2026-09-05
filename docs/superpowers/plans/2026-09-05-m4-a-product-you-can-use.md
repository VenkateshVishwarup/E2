# M4 — A product you can use

Closes the gap named on 2026-09-05: everything built so far sits *downstream* of a
conversation that never happens. This milestone makes the conversation happen.

**Scope, as the owner set it:**

1. Journeys stay YAML, with a default one shipped — but editable in the console
2. Publishing is deployment. There is no separate deploy step
3. Real people chat with the agent
4. Imported history stays; live conversations accumulate alongside it

---

## The property everything depends on

A live conversation must write **exactly the same events** a simulated one writes, or every
fold downstream silently means something different for live traffic than for sim. Today the
`Action[] -> EventInput[]` translation lives inside `SimulationRunner`. Two copies of it
would diverge within a week.

So it is extracted first, and both callers use it. Live and sim then differ in exactly two
respects, both of which are already modelled: `env` (`live` vs `sim`) and `runId`
(null vs set).

---

## Task 1 — Extract the action-to-event translation (`runtime/src/persist.ts`)

`actionsToEvents(actions, base, channel)` returns the events plus the decisions a caller
needs to drive the loop: what was sent, whether it escalated, whether it completed.

`SimulationRunner` switches to it. Its behaviour must not change — the existing simulate
tests are the regression net.

## Task 2 — Make seeding additive (`core`, `scripts/`)

Seeds currently `TRUNCATE events`, which would delete every real conversation the moment
someone reseeds. Each script instead deletes only what it owns:

| script | owns |
|---|---|
| `seed`, `roi` | `lead_id LIKE 'L\_%'` — synthetic historical cohorts |
| `simulate` | `env = 'sim'` |
| chat | `web_*` — **never** deleted by a seed |

`journey_versions` stops being truncated. `registry.publish` gains a companion that is
idempotent for an *identical* republish and still refuses a changed one — versions remain
immutable, but re-running a seed is not a violation of that.

## Task 3 — The chat loop (`web`)

```
POST /api/chat/sessions                    -> { leadId, version, opening }
POST /api/chat/sessions/{leadId}/messages  -> { reply, state }
GET  /api/chat/sessions/{leadId}           -> full state
```

A session is a lead. Events are `live`-scoped with no `runId`, so they land in the same
log the ROI and insight screens already read — a chat conversation is not a special case,
it is the ordinary case that was missing.

**Version assignment goes through the existing `TrafficAllocator`.** Pass an explicit
`version`, or a `split` like `{"4": 50, "5": 50}` and the allocator assigns
deterministically by lead. That is live A/B — new agents taking real traffic without
touching the existing one — for the cost of wiring, because the allocator is already built
and tested.

**State is returned on every turn**, and it is the demo: evidence as it is extracted, which
required fields are still missing, the score, the route, and the token cost so far. Watching
the evidence contract fill in while you type is the argument for declaring journeys rather
than prompting them.

Token cost is metered per turn and written as `CostObserved`, so the ROI screen's model
column stops reading zero.

## Task 4 — Console: Chat tab

Conversation on the left, live state on the right. Version selector including an A/B split.
Offline mode is labelled, because a keyword extractor answering is not the product.

## Task 5 — Console: Journey editor tab

Load a version's YAML, edit it, lint as you type, publish. Publishing bumps the version and
the new one is immediately servable by chat — which is what makes "publish is deploy" true
rather than asserted. Lint warnings appear before publish, not after.

## Task 6 — ROI on tokens

The owner's definition: **tokens spent on users, against qualified leads and conversions.**
Model cost becomes the headline; allocated ad spend becomes the secondary column it should
always have been.

---

## Done when

A person opens the console, edits the journey, publishes it, chats with the agent, watches
evidence fill in, and then sees that conversation counted in ROI with its real token cost —
without any of it disturbing the imported history already there.
