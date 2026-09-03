import Anthropic from "@anthropic-ai/sdk";

/** Exact model id. Never append a date suffix. */
export const MODEL = "claude-opus-5" as const;

/** Non-streaming ceiling — keeps requests inside the SDK HTTP timeout. */
export const MAX_TOKENS = 16000;

export function createClient(): Anthropic {
  // Resolves ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, or an `ant auth login`
  // profile. Never hardcode a key.
  return new Anthropic();
}

/**
 * The journey spec is byte-identical across every conversation in a run, and
 * render order is tools -> system -> messages. Putting the spec in a cached
 * system block puts the breakpoint exactly where the stable prefix ends.
 */
export function cachedSystem(text: string): Anthropic.TextBlockParam[] {
  return [{ type: "text", text, cache_control: { type: "ephemeral" } }];
}
