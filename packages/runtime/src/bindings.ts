import type { JourneySpec } from "@midfunnel/core/journey/spec";
import type { Binding } from "./broker.js";

/**
 * What stands behind a capability the journey declares.
 *
 * A journey says `binding: hubspot`. It does NOT say where HubSpot is or how to
 * authenticate to it — that is deployment configuration, and a credential in a
 * spec is a credential in version control, in a diff, and on the Journey screen.
 * So the spec holds a name and the environment holds the rest:
 *
 *   BINDING_HUBSPOT_URL      https://crm.internal/e2/hooks
 *   BINDING_HUBSPOT_TOKEN    (the secret itself, injected by the platform)
 *   BINDING_HUBSPOT_TIMEOUT  optional, milliseconds
 *
 * A binding with no URL configured falls back to the mock, and says so. That is
 * the difference between a demo that quietly pretends and one that tells you
 * which destinations are real.
 */
export type BindingMode = "live" | "mock";

export interface BindingStatus {
  capability: string;
  /** The name the journey declared: hubspot, calendly, internal. */
  binding: string;
  mode: BindingMode;
  /** Host only — never the path, the query or the token. */
  endpoint: string | null;
  /** Why it is a mock, when it is one. */
  reason: string | null;
}

export interface HttpBindingConfig {
  url: string;
  token?: string;
  timeoutMs: number;
}

/** Env var names for a binding, so the naming lives in exactly one place. */
export function envNames(binding: string) {
  const key = binding.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    url: `BINDING_${key}_URL`,
    token: `BINDING_${key}_TOKEN`,
    timeout: `BINDING_${key}_TIMEOUT`,
  };
}

const DEFAULT_TIMEOUT_MS = 8000;

export function configFor(
  binding: string, env: NodeJS.ProcessEnv = process.env,
): HttpBindingConfig | null {
  const names = envNames(binding);
  const url = env[names.url]?.trim();
  if (!url) return null;
  const timeout = Number(env[names.timeout]);
  return {
    url,
    ...(env[names.token] ? { token: env[names.token] } : {}),
    timeoutMs: Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS,
  };
}

/**
 * One outbound call to a real system.
 *
 * Deliberately NOT retried. A CRM upsert would survive a second attempt, but a
 * calendar booking would not, and the broker cannot tell which is which from a
 * capability name. A failure is returned, recorded as a `ToolInvoked` with an
 * error status, and visible — which is better than a lead silently double-booked
 * because a response was slow.
 */
export function httpBinding(capability: string, config: HttpBindingConfig): Binding {
  return async (args, scope) => {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.token ? { authorization: `Bearer ${config.token}` } : {}),
      },
      body: JSON.stringify({ capability, scope: scope ?? null, args }),
      // A tool call sits inside a lead's turn. Waiting on a hung integration
      // holds up the conversation, so the deadline is short and explicit.
      signal: AbortSignal.timeout(config.timeoutMs),
    });

    if (!response.ok) {
      // The body may carry a useful message and may carry anything at all, so
      // a bounded prefix of it goes in the error and nothing goes in the log.
      const detail = (await response.text().catch(() => "")).slice(0, 200);
      throw new Error(`${config.url.replace(/\?.*$/, "")} returned ${response.status}${detail ? `: ${detail}` : ""}`);
    }
    return response.status === 204 ? null : await response.json().catch(() => null);
  };
}

/**
 * The bindings a journey's tools resolve to, keyed by capability.
 *
 * Resolution goes through the name the journey declared, which it did not
 * before: every capability got a mock keyed by capability alone, so a journey
 * that said `binding: hubspot` and one that said `binding: salesforce` reached
 * exactly the same place and the spec's answer to "which system" was decoration.
 */
export function bindingsFor(
  spec: JourneySpec,
  mocks: Record<string, Binding>,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, Binding> {
  const out: Record<string, Binding> = {};
  for (const tool of spec.tools) {
    const config = configFor(tool.binding, env);
    const mock = mocks[tool.capability];
    if (config) out[tool.capability] = httpBinding(tool.capability, config);
    else if (mock) out[tool.capability] = mock;
  }
  return out;
}

/** What each declared tool actually reaches, for the console and the API. */
export function describeBindings(
  spec: JourneySpec,
  mocks: Record<string, Binding>,
  env: NodeJS.ProcessEnv = process.env,
): BindingStatus[] {
  return spec.tools.map((tool) => {
    const config = configFor(tool.binding, env);
    if (config) {
      return {
        capability: tool.capability, binding: tool.binding, mode: "live" as const,
        // Host only. A full URL in a response is a path and a query string in
        // a screenshot.
        endpoint: hostOf(config.url), reason: null,
      };
    }
    const names = envNames(tool.binding);
    return {
      capability: tool.capability, binding: tool.binding, mode: "mock" as const,
      endpoint: null,
      reason: mocks[tool.capability]
        ? `${names.url} is not set`
        : `${names.url} is not set and there is no mock for ${tool.capability}`,
    };
  });
}

function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return "(unparseable URL)"; }
}
