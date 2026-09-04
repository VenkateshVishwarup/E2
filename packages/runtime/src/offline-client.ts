import type OpenAI from "openai";

/**
 * A model-free stand-in for the provider client.
 *
 * The runtime needs *something* to generate a follow-up question. Replay never
 * asks one (the transcript is finished), but simulation does — so passing an
 * empty object crashes the moment a conversation needs its second turn.
 *
 * This generates a plain question from the field the runtime asked about. It is
 * deterministic, free, and obviously not the real agent — which is the point:
 * paired with KeywordExtractor it makes the whole pipeline runnable offline,
 * for CI, for local work, and for demonstrating the plumbing without spend.
 */
export function offlineClient(): OpenAI {
  return {
    responses: {
      create: async (body: { input?: string }) => {
        let field = "that";
        try {
          const parsed = JSON.parse(body.input ?? "{}") as { ask_about?: { field?: string } };
          field = parsed.ask_about?.field ?? field;
        } catch {
          // Non-JSON input: fall back to the generic phrasing.
        }
        return { output_text: `Could you tell me your ${field.replace(/_/g, " ")}?` };
      },
    },
  } as unknown as OpenAI;
}
