import type OpenAI from "openai";
import * as z from "zod/v4";
import { zodTextFormat } from "openai/helpers/zod";
import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { createClient, MAX_TOKENS, modelFor } from "@midfunnel/runtime/provider";
import { CostMeter } from "@midfunnel/runtime/meter";
import { CopilotTools } from "./tools.js";
import type { Answer, ProposedDiff, View } from "./types.js";

const viewSchema = z.object({
  kind: z.enum(["bar", "table", "stat", "none"]),
  title: z.string(),
  unit: z.string().nullable(),
  series: z.array(z.object({
    label: z.string(),
    value: z.number(),
    band: z.enum(["observed", "modelled"]).nullable(),
  })).nullable().describe("For kind=bar."),
  columns: z.array(z.string()).nullable().describe("For kind=table."),
  rows: z.array(z.array(z.string())).nullable().describe("For kind=table."),
  value: z.string().nullable().describe("For kind=stat."),
  caption: z.string().nullable().describe("For kind=stat."),
});

const answerSchema = z.object({
  text: z.string().describe("Two to four sentences. Lead with the number that answers the question."),
  view: viewSchema.nullable().describe("A rendering of the data behind the answer, or null."),
});

const TOOLS = [
  {
    type: "function" as const, name: "roi", strict: true,
    description: "Cost and outcome totals attributed campaign -> creative -> journey version.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { journey: { type: "string" } }, required: ["journey"],
    },
  },
  {
    type: "function" as const, name: "insights", strict: true,
    description: "Ranked findings about this journey, each with support and a confidence interval.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { journey: { type: "string" } }, required: ["journey"],
    },
  },
  {
    type: "function" as const, name: "cohort", strict: true,
    description: "Conversion broken down by one dimension: campaign, creative, version, " +
                 "decision, or evidence.<field>.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { journey: { type: "string" }, dimension: { type: "string" } },
      required: ["journey", "dimension"],
    },
  },
  {
    type: "function" as const, name: "read_spec", strict: true,
    description: "The authored YAML for a journey version. Read this before proposing a change.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: { journey: { type: "string" }, version: { type: ["integer", "null"] } },
      required: ["journey", "version"],
    },
  },
  {
    type: "function" as const, name: "propose_diff", strict: true,
    description: "Propose a new journey version. The full YAML, with the version bumped. " +
                 "It is parsed, linted and diffed before it is accepted; if it fails you " +
                 "will be told why and may correct it. Nothing is published.",
    parameters: {
      type: "object", additionalProperties: false,
      properties: {
        journey: { type: "string" },
        yaml: { type: "string" },
        rationale: { type: "string", description: "One sentence tying the change to the data." },
      },
      required: ["journey", "yaml", "rationale"],
    },
  },
];

const MAX_TURNS = 8;

/**
 * The marketer's and FDE's agent over the whole system. It reads through the
 * same folds the console screens read, so an answer here and a number on a
 * screen cannot disagree.
 */
export class Copilot {
  private readonly client: OpenAI;
  private readonly tools: CopilotTools;
  readonly meter = new CostMeter();

  constructor(store: EventStore, registry: JourneyRegistry, client?: OpenAI) {
    this.client = client ?? createClient();
    this.tools = new CopilotTools(store, registry);
  }

  async ask(journey: string, question: string): Promise<Answer> {
    const used: string[] = [];
    let diff: ProposedDiff | undefined;
    const input: Array<Record<string, unknown>> = [{ role: "user", content: question }];
    const model = modelFor("copilot");

    for (let turn = 0; turn < MAX_TURNS; turn++) {
      const response = await this.client.responses.parse({
        model,
        max_output_tokens: MAX_TOKENS,
        // Marketer-facing reasoning that proposes spec changes: the one place
        // in the system where thinking time is worth more than throughput.
        reasoning: { effort: "high" },
        instructions: instructions(journey),
        tools: TOOLS,
        text: { format: zodTextFormat(answerSchema, "answer") },
        input: input as never,
      });

      this.meter.record(model, response.usage);

      const calls = (response.output ?? []).filter((o) => o.type === "function_call");

      if (calls.length === 0) {
        const parsed = response.output_parsed as z.infer<typeof answerSchema> | null;
        if (!parsed) throw new Error("copilot received no structured answer from the model");
        return {
          text: parsed.text,
          ...(toView(parsed.view) ? { view: toView(parsed.view)! } : {}),
          ...(diff ? { diff } : {}),
          usedTools: used,
          offline: false,
        };
      }

      for (const call of calls) {
        input.push(call as unknown as Record<string, unknown>);
        used.push(call.name);
        const output = await this.run(call.name, call.arguments, journey)
          .then((r) => {
            if (call.name === "propose_diff") diff = r as ProposedDiff;
            return JSON.stringify(r);
          })
          // A rejected proposal goes back to the model as an error to correct,
          // never out to the user as a suggestion they discover is broken.
          .catch((err: Error) => JSON.stringify({ error: err.message }));
        input.push({ type: "function_call_output", call_id: call.call_id, output });
      }
    }

    throw new Error(`copilot exceeded ${MAX_TURNS} tool turns without answering`);
  }

  private async run(name: string, rawArgs: string, journey: string): Promise<unknown> {
    const args = JSON.parse(rawArgs || "{}") as Record<string, unknown>;
    // The journey is fixed by the caller, not chosen by the model: a copilot
    // that can retarget its own scope is a tenancy hole waiting to happen.
    switch (name) {
      case "roi": return this.tools.roi(journey);
      case "insights": return this.tools.insights(journey);
      case "cohort": return this.tools.cohort(journey, String(args.dimension));
      case "read_spec":
        return this.tools.readSpec(journey,
          typeof args.version === "number" ? args.version : undefined);
      case "propose_diff":
        return this.tools.proposeDiff(journey, String(args.yaml), String(args.rationale));
      default: throw new Error(`unknown tool: ${name}`);
    }
  }
}

function instructions(journey: string): string {
  return [
    "You are the copilot for a mid-funnel lead-qualification platform, answering a",
    "marketer or a forward-deployed engineer about their own live data.",
    `The journey in scope is "${journey}". Every tool reads it; you cannot query another.`,
    "",
    "Rules:",
    "- Answer from the tools. Never state a number you did not read from one.",
    "- Cite support. A rate without an n is not an answer.",
    "- If a finding carries a confidence interval, mention it.",
    "- When the data implies a journey change, read the spec and propose a diff.",
    "  Bump the version. Change as little as possible.",
    "- Return a view when a comparison is easier to see than to read. Otherwise null.",
    "- If the tools do not support the question, say so plainly rather than guessing.",
  ].join("\n");
}

/** Collapses the flat model-facing shape into the discriminated union. */
function toView(v: z.infer<typeof viewSchema> | null | undefined): View | null {
  if (!v || v.kind === "none") return null;
  if (v.kind === "bar") {
    return {
      kind: "bar", title: v.title,
      ...(v.unit ? { unit: v.unit } : {}),
      series: (v.series ?? []).map((s) => ({
        label: s.label, value: s.value, ...(s.band ? { band: s.band } : {}),
      })),
    };
  }
  if (v.kind === "table") {
    return { kind: "table", title: v.title, columns: v.columns ?? [], rows: v.rows ?? [] };
  }
  return {
    kind: "stat", title: v.title, value: v.value ?? "",
    ...(v.caption ? { caption: v.caption } : {}),
  };
}
