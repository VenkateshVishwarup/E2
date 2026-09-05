import type OpenAI from "openai";

/**
 * A model-free stand-in for the provider client.
 *
 * The runtime needs *something* to generate a follow-up question. Replay never
 * asks one (the transcript is finished), but simulation and live chat do — so
 * passing an empty object crashes the moment a conversation needs its second
 * turn.
 *
 * The question it writes names the declared options, because the extractor
 * paired with it only understands those. Without them a person is guessing at
 * a vocabulary they cannot see, and the offline demo reads as broken rather
 * than as deliberately model-free.
 */
export function offlineClient(): OpenAI {
  return {
    responses: {
      create: async (body: { input?: string }) => {
        const ask = parseAsk(body.input);
        const field = (ask.field ?? "that").replace(/_/g, " ");
        const options = enumValues(ask.type);

        const question = ask.description
          ? `${ask.description}?`
          : `Could you tell me your ${field}?`;

        return {
          output_text: options.length > 0
            ? `${question} (${options.join(", ")})`
            : question,
        };
      },
    },
  } as unknown as OpenAI;
}

interface Ask { field?: string; type?: string; description?: string | null }

function parseAsk(input: string | undefined): Ask {
  try {
    return (JSON.parse(input ?? "{}") as { ask_about?: Ask }).ask_about ?? {};
  } catch {
    return {}; // Non-JSON input: fall back to the generic phrasing.
  }
}

function enumValues(type: string | undefined): string[] {
  const m = /^enum\[(.+)\]$/.exec((type ?? "").trim());
  return m ? m[1]!.split(",").map((v) => v.trim().replace(/_/g, " ")).filter(Boolean) : [];
}
