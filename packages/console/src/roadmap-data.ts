/**
 * What E2 does not do yet.
 *
 * Kept in one place and shown in the product rather than hidden, because a
 * demo that quietly implies a missing capability is worse than one that names
 * it. Each item says what exists today, so the gap is a next step rather than a
 * blank — and so nobody has to guess how far off it is.
 */
export interface RoadmapItem {
  id: string;
  title: string;
  /** What it will do. */
  will: string;
  /** What is already in place, so this is an extension rather than a rewrite. */
  today: string;
  horizon: "next" | "planned" | "later";
}

export const ROADMAP: RoadmapItem[] = [
  {
    id: "channels",
    title: "A vendor on the end of WhatsApp and voice",
    will: "Ship adapters for a real messaging and telephony vendor — their payload shape, " +
          "their webhook signature, delivery receipts and media — rather than one generic " +
          "send-and-receive shape.",
    today: "The same journey already runs over web chat, WhatsApp and voice: the runtime " +
           "never sees the channel, and what changes at the edge is the wording and the " +
           "delivery. A spoken message has its bracketed option lists reworded into lists " +
           "a person can say. An inbound message is addressed by phone number and finds " +
           "its conversation through the log, so a reply can be handled by a different " +
           "process from the one that asked. Consent is an allow-list checked at the last " +
           "point before a message leaves, and a refusal is recorded as a policy event. " +
           "Point CHANNEL_WHATSAPP_URL at a vendor and it is delivered for real; " +
           "unconnected, it is recorded and the screen says so.",
    horizon: "next",
  },
  {
    id: "bindings",
    title: "Vault-held credentials, and the rest of the vendors",
    will: "Hold integration credentials in a secrets manager rather than environment " +
          "variables, rotate them without a redeploy, and ship adapters that speak each " +
          "vendor's own API rather than one generic webhook shape.",
    today: "A journey names the system it reaches (`binding: hubspot`) and the deployment " +
           "supplies the endpoint and credential, so a secret is never in a spec, a diff " +
           "or on screen. A configured binding makes a real call with a deadline, and the " +
           "event records which system and whether the call was live — a booking against a " +
           "mock and a booking against a calendar are not the same row. Unconfigured " +
           "bindings fall back to mocks and the Journey screen names the variable that " +
           "would make each one real.",
    horizon: "next",
  },
  {
    id: "variance",
    title: "Compare, range against range",
    will: "Repeat both arms of a comparison over the same cohort and give the verdict on " +
          "their ranges, so a non-deterministic version is not judged on whichever run it " +
          "happened to draw.",
    today: "Simulate already repeats a version over the same personas and reports the range " +
           "of every figure, and how many runs each alert fired in. Compare still runs each " +
           "arm once, so its verdict is one run against one run. Replay says outright that " +
           "it cannot see a strategy change — it runs over transcripts the other strategy " +
           "produced.",
    horizon: "next",
  },
  {
    id: "alerts",
    title: "Alerts that reach someone",
    will: "Route a fired threshold to email, Slack or a pager, with an owner and an " +
          "escalation path.",
    today: "Thresholds are declared and evaluated, and alerts fire with severity and the " +
           "observed value. They surface on the Simulate screen and stop there.",
    horizon: "planned",
  },
  {
    id: "parallel",
    title: "Parallel run against your current stack",
    will: "Send a slice of live traffic to this platform and the rest to whatever you run " +
           "today, and compare on one scoreboard. Adoption becomes a dial, not a cutover.",
    today: "The traffic allocator already treats a target as opaque, so \"journey@5\" against " +
           "\"external:incumbent\" is the same primitive as an A/B. It has no screen and no " +
           "connector to an incumbent system.",
    horizon: "planned",
  },
  {
    id: "tenancy",
    title: "Multi-tenancy",
    will: "One deployment serving many customers, with the tenant resolved from the request " +
          "and row-level security enforcing the boundary in the database.",
    today: "Every row carries a tenant id from the first event ever written, and no read " +
           "path is unscoped. The tenant is fixed per process rather than per request.",
    horizon: "planned",
  },
  {
    id: "benchmarks",
    title: "Benchmarks across customers",
    will: "\"Your timeline collection rate is 41%; the edtech median is 68%.\" The comparison " +
          "no competitor can make without a comparable corpus — and the reason the data " +
          "compounds into a moat rather than sitting in a warehouse.",
    today: "Every conversation already contributes the tuple this needs: journey version, " +
           "evidence collected, path taken, outcome observed. It needs more than one tenant " +
           "and a consent model for aggregation.",
    horizon: "later",
  },
  {
    id: "onprem",
    title: "On-premise deployment",
    will: "Run entirely inside a customer's estate, against their own model endpoint.",
    today: "One Postgres, no queue, no broker, and a single model client behind one " +
           "interface. Bedrock, Vertex or a self-hosted model is a constructor change, " +
           "which is what makes this credible rather than aspirational.",
    horizon: "later",
  },
  {
    id: "agents",
    title: "Agent registry screen",
    will: "Manage agent identities and privileges directly, rather than editing them inside " +
          "a journey spec.",
    today: "Agents are principals already: every event carries an agent id, and the broker " +
           "enforces the privilege list. It is authored in the journey YAML and has no UI.",
    horizon: "later",
  },
];

export const item = (id: string): RoadmapItem =>
  ROADMAP.find((r) => r.id === id)!;
