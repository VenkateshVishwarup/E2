# Tool broker

`packages/runtime/src/broker.ts` · `core/src/agent/registry.ts`

The agent is a **principal**, not a script. Every event carries an `agent_id`, and
privileges are *enforced* at the broker rather than declared in the spec and hoped for.

An unprivileged call is denied and written as an `AuthorizationDenied` event. Arguments are
hashed, never logged.

Identity landed in M1 rather than later because retrofitting a principal after the event
schema is in use is a migration, not an edit — `agent_id` had to be on the first event ever
written.

The broker is also the single egress point, which is where data residency and consent
enforcement will live. Bindings today are mocks: the enforcement is genuine, the
destinations are not.

Related: [event spine](event-spine.md) · [journey spec](journey-spec.md)
