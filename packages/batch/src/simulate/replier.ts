import type OpenAI from "openai";
import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { Turn } from "@midfunnel/core/events/types";
import { cacheKey, createClient, MAX_TOKENS, PERSONA_MODEL } from "@midfunnel/runtime/provider";
import type { Persona } from "./persona.js";

export interface Replier {
  /** Returns the lead's next message, or null if they have ghosted. */
  reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null>;
}

const MOOD_TEXT: Record<Persona["mood"], string> = {
  positive: "great, that sounds good",
  neutral: "ok",
  frustrated: "this is frustrating, feels like a waste of time",
};

const OBJECTION_TEXT: Record<Persona["objection"], string> = {
  none: "",
  price: " though the fees look steep",
  time: " but I do not have much time right now",
  trust: " and I am not sure this is legitimate",
};

/**
 * Deterministic replier. Used for tests, for reproducible A/B runs, and
 * whenever no OpenAI credential is configured.
 *
 * It answers ONE field per turn, so it never leaks ground truth that was not
 * asked for — which is what keeps extraction-correctness a real measurement.
 */
export class ScriptedReplier implements Replier {
  async reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> {
    const leadTurns = turns.filter((t) => t.role === "lead").length;
    if (persona.dropoffAfterTurn !== null && leadTurns >= persona.dropoffAfterTurn) return null;

    const lastAgent = [...turns].reverse().find((t) => t.role === "agent");
    if (!lastAgent) return null;

    const asked = lastAgent.text.toLowerCase();
    const alreadySaid = turns.filter((t) => t.role === "lead")
      .map((t) => t.text.toLowerCase()).join(" ");

    const field = this.identify(spec, asked) ?? this.nextUnsaid(persona, alreadySaid);

    const mood = MOOD_TEXT[persona.mood];
    const objection = OBJECTION_TEXT[persona.objection];

    if (!field) return `${mood}${objection}`.trim();

    const value = persona.truth[field];
    // Uncooperative leads deflect rather than answer.
    if (value === undefined || persona.cooperation < 0.4) {
      return `not sure about that${objection || ", let me think"}`;
    }

    switch (persona.verbosity) {
      case "terse":  return value;
      case "chatty": return `${mood}, I would say ${value}${objection}`;
      default:       return `${value}${objection}`;
    }
  }

  /**
   * Which evidence field is this question about? Field names are matched
   * word-by-word rather than as a joined phrase: "budget_band" has to match
   * "what is your budget range?", which "budget band" never would.
   */
  private identify(spec: JourneySpec, asked: string): string | null {
    for (const [name, def] of Object.entries(spec.evidence)) {
      const hints = [
        ...name.split("_"),
        ...(def.description ?? "").toLowerCase().split(/\s+/),
      ].filter((h) => h.length > 3);
      if (hints.some((h) => asked.includes(h))) return name;
    }
    return null;
  }

  /**
   * Fallback when the question cannot be attributed: answer the next fact not
   * yet volunteered. A real lead who understands a question answers it, so a
   * double that stalls would make every conversation look like a ghosting.
   */
  private nextUnsaid(persona: Persona, alreadySaid: string): string | null {
    for (const [field, value] of Object.entries(persona.truth)) {
      if (!alreadySaid.includes(value.toLowerCase())) return field;
    }
    return null;
  }
}

/**
 * Model-backed replier. `gpt-5.6-terra` at low effort: personas need to be
 * plausible, not brilliant, and this is the volume driver in a simulation run.
 */
export class ModelReplier implements Replier {
  private readonly client: OpenAI;

  constructor(client?: OpenAI) {
    this.client = client ?? createClient();
  }

  async reply(persona: Persona, spec: JourneySpec, turns: Turn[]): Promise<string | null> {
    const leadTurns = turns.filter((t) => t.role === "lead").length;
    if (persona.dropoffAfterTurn !== null && leadTurns >= persona.dropoffAfterTurn) return null;

    const transcript = turns
      .map((t) => `${t.role === "agent" ? "AGENT" : "YOU"}: ${t.text}`)
      .join("\n");

    const response = await this.client.responses.create({
      model: PERSONA_MODEL,
      max_output_tokens: MAX_TOKENS,
      reasoning: { effort: "low" },
      prompt_cache_key: `persona:${cacheKey(spec.journey, spec.version)}`,
      instructions: [
        `You are role-playing a prospective ${spec.vertical} student contacted over WhatsApp.`,
        "",
        "Reply as the PROSPECT, never as the agent. One short message, under 25 words.",
        "No preamble, no quotation marks, no stage directions.",
        "",
        "Facts true about you (reveal only what is actually asked, never volunteer the rest):",
        ...Object.entries(persona.truth).map(([k, v]) => `- ${k}: ${v}`),
        "",
        `Mood: ${persona.mood}. Verbosity: ${persona.verbosity}.`,
        `Cooperation: ${persona.cooperation} (0 = evasive, 1 = fully forthcoming).`,
        persona.objection === "none" ? "" : `You have an unspoken objection about ${persona.objection}.`,
      ].filter(Boolean).join("\n"),
      input: transcript,
    });

    return response.output_text.trim() || null;
  }
}
