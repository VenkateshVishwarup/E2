/**
 * What carries a message, and what a lead agreed to be reached on.
 *
 * The agent does not change per channel. It returns intents and the caller
 * delivers them, so a journey runs over web chat, WhatsApp or a phone call
 * without the runtime knowing which. Two things do change, and both live here:
 * what a lead consented to, and how a sentence is worded for the medium.
 */
export const CHANNELS = ["web", "whatsapp", "voice"] as const;

export type Channel = (typeof CHANNELS)[number];

export function isChannel(v: unknown): v is Channel {
  return typeof v === "string" && (CHANNELS as readonly string[]).includes(v);
}

export interface ChannelTraits {
  label: string;
  /** Longest single message the medium accepts, or null for no practical limit. */
  maxLength: number | null;
  /**
   * True when the message is spoken. Brackets, slashes and bullet lists are
   * read aloud literally, so they have to go.
   */
  spoken: boolean;
  /** How a lead is addressed on this channel, for the inbound webhook. */
  address: string;
}

export const CHANNEL_TRAITS: Record<Channel, ChannelTraits> = {
  web: { label: "Web chat", maxLength: null, spoken: false, address: "session id" },
  // WhatsApp accepts 4096, but a qualification question that long is a failure
  // of a different kind. This is the point at which to split, not the API's.
  whatsapp: { label: "WhatsApp", maxLength: 1000, spoken: false, address: "phone number" },
  voice: { label: "Voice", maxLength: 350, spoken: true, address: "phone number" },
};

/**
 * Adapts one agent message to the medium carrying it.
 *
 * The runtime writes "Could you tell me your timeline? (this intake, next
 * intake, just exploring)" — which reads fine and is unusable spoken: a
 * text-to-speech engine says the bracket, and a caller hears a list with no
 * grammar. Rewording at the edge rather than per channel inside the agent is
 * what keeps one journey serving every channel.
 *
 * Returns the text as it will be sent, plus whether anything had to be cut, so
 * truncation is recorded rather than silently applied.
 */
export function renderForChannel(
  text: string, channel: Channel,
): { text: string; truncated: boolean } {
  const traits = CHANNEL_TRAITS[channel];
  let out = text.trim();

  if (traits.spoken) out = speakable(out);

  if (traits.maxLength !== null && out.length > traits.maxLength) {
    // Cut at a sentence end where there is one in the last fifth of the budget,
    // so a trimmed message still ends like a sentence.
    const hard = out.slice(0, traits.maxLength - 1);
    const breakAt = hard.lastIndexOf(". ");
    const keep = breakAt > traits.maxLength * 0.8 ? hard.slice(0, breakAt + 1) : `${hard.trimEnd()}…`;
    return { text: keep, truncated: true };
  }
  return { text: out, truncated: false };
}

/**
 * Prose a speech engine can read.
 *
 * A parenthetical list is the common case and the worst one, so it becomes a
 * spoken list with an "or" before the last item.
 */
function speakable(text: string): string {
  return text
    .replace(/\s*\(([^)]+)\)\s*/g, (_, inner: string) => {
      const parts = inner.split(/\s*,\s*/).map((p) => p.trim()).filter(Boolean);
      if (parts.length < 2) return ` — ${inner.trim()} `;
      return ` — ${parts.slice(0, -1).join(", ")} or ${parts.at(-1)} `;
    })
    // Underscores reach a lead only through a declared enum value; spoken, they
    // are silence in the middle of a word.
    .replace(/(\w)_(\w)/g, "$1 $2")
    .replace(/\s*\/\s*/g, " or ")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([,.!?])/g, "$1")
    .trim();
}

/**
 * Whether a lead agreed to be reached on a channel.
 *
 * An allow-list, and an empty one reaches nobody. Consent is the one thing a
 * channel rollout can get wrong in a way that is not recoverable by an
 * apology, so absence is refusal rather than "not specified".
 */
export function consented(consentChannels: readonly string[], channel: Channel): boolean {
  return consentChannels.includes(channel);
}
