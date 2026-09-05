# Version lifecycle

`packages/core/src/journey/registry.ts` · migration `004_live_pointer.sql`

Four states, three transitions.

```
draft (in the editor)  ──publish──▶  published  ──promote──▶  live
                                          ▲                     │
                                          └──────promote────────┘
                                              (roll back)
```

## Why publishing is not shipping

They were the same act at first, and that left no way to try a version before real traffic
met it — the only way to test a change was to ship it. They are now separate:

- **Publish** makes a version exist. It is immutable, addressable, and can be talked to on
  the Chat tab. Republishing a version number returns 409.
- **Promote** points `journey_live` at it. Instant, and reversible by promoting the
  previous version back.

The first version of a journey goes live on publish, because a journey with no live version
serves nobody. Every version after it has to be promoted deliberately.

## Where live is read

- A chat session with no version named gets the live one
- The Chat tab's A/B split defaults to **live versus the newest candidate**
- Sessions already running keep the version they started on: a conversation whose agent
  changed mid-way would be neither version's result

## Why a table, not a column

`journey_live` has a primary key of `(tenant_id, journey)`, so "exactly one live version per
journey" is enforced by the database rather than by remembering a rule. A boolean column
would allow two.

Related: [journey spec](journey-spec.md) · [live conversation](live-conversation.md)
