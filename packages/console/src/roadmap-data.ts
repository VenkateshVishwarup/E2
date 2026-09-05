/**
 * What this platform does not do yet.
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
    title: "WhatsApp and voice",
    will: "Run the same journeys over WhatsApp and voice, not just the web chat here. " +
          "The agent does not change — only what carries the message.",
    today: "The runtime never sees the channel: it returns intents and the caller delivers " +
           "them. Every message event already records its channel, and consent scope is " +
           "captured at ingestion so a channel a lead did not consent to is unreachable.",
    horizon: "next",
  },
  {
    id: "journeys",
    title: "More than one journey",
    will: "Create, list and switch between journeys — one per programme, per vertical, per " +
          "client — each with its own versions, metrics and agents.",
    today: "The registry is already keyed by journey and every event carries one. The " +
           "console is pinned to a single journey; nothing beneath it is.",
    horizon: "next",
  },
  {
    id: "bindings",
    title: "Real integrations",
    will: "Book into a live calendar and write to a live CRM, with credentials held in a " +
          "vault and referenced — never stored — by the journey.",
    today: "The Tool Broker is real and privileges are enforced, not merely declared: an " +
           "unprivileged call is denied and logged as an event. The bindings behind it are " +
           "mocks, so the enforcement is genuine and the destinations are not.",
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
