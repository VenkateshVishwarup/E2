import { CHANNEL_TRAITS, type Channel } from "@midfunnel/core/channels";
import { configFor, envNames } from "@midfunnel/runtime/bindings";

/**
 * Getting a message to a lead on a channel that is not the web.
 *
 * Web chat needs no transport: the reply is the HTTP response to the request
 * that produced it. WhatsApp and voice need somebody to carry it, and that
 * somebody is a vendor configured by the deployment, exactly as a journey's
 * tool bindings are:
 *
 *   CHANNEL_WHATSAPP_URL    https://messaging.vendor/send
 *   CHANNEL_WHATSAPP_TOKEN  injected by the platform
 *
 * Unconfigured, delivery is recorded and not attempted. That is the honest
 * state for a demo: the conversation, the consent check and the channel-adapted
 * wording are all real, and the last hop is not.
 */
export type DeliveryStatus = "sent" | "recorded" | "refused" | "not_applicable";

export interface DeliveryResult {
  status: DeliveryStatus;
  /** Why, when it is not `sent`. */
  detail: string | null;
}

export interface Transport {
  send(to: string, text: string): Promise<void>;
}

export function transportFor(
  channel: Channel, env: NodeJS.ProcessEnv = process.env,
): Transport | null {
  const config = configFor(channel, env, "CHANNEL");
  if (!config) return null;
  return {
    async send(to, text) {
      const response = await fetch(config.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
        },
        body: JSON.stringify({ channel, to, text }),
        signal: AbortSignal.timeout(config.timeoutMs),
      });
      if (!response.ok) {
        const detail = (await response.text().catch(() => "")).slice(0, 200);
        throw new Error(`delivery returned ${response.status}${detail ? `: ${detail}` : ""}`);
      }
    },
  };
}

export interface ChannelStatus {
  channel: Channel;
  label: string;
  /** Whether a message would actually leave this process. */
  configured: boolean;
  endpoint: string | null;
  /** What would make it real, when it is not. */
  reason: string | null;
  maxLength: number | null;
  spoken: boolean;
}

export function describeChannels(env: NodeJS.ProcessEnv = process.env): ChannelStatus[] {
  return (Object.keys(CHANNEL_TRAITS) as Channel[]).map((channel) => {
    const traits = CHANNEL_TRAITS[channel];
    const base = {
      channel, label: traits.label,
      maxLength: traits.maxLength, spoken: traits.spoken,
    };
    if (channel === "web") {
      return {
        ...base, configured: true, endpoint: null,
        reason: "the reply is the response to the request that produced it",
      };
    }
    const config = configFor(channel, env, "CHANNEL");
    if (!config) {
      return {
        ...base, configured: false, endpoint: null,
        reason: `${envNames(channel, "CHANNEL").url} is not set, so messages are recorded and not sent`,
      };
    }
    let host: string;
    try { host = new URL(config.url).host; } catch { host = "(unparseable URL)"; }
    return { ...base, configured: true, endpoint: host, reason: null };
  });
}
