import type { JourneySpec } from "../journey/spec.js";

export interface AgentPrincipal {
  identity: string;
  persona: string;
  privileges: string[];
  dataScope: { read: string[]; deny: string[] };
}

export interface AuthzResult {
  allowed: boolean;
  scope?: string;
  reason?: string;
}

/**
 * MVP: agents are declared inline in the journey spec. When a shared agent
 * registry arrives this becomes a lookup by identity — the journey format and
 * every call site here stay unchanged.
 */
export class AgentRegistry {
  private constructor(private readonly agents: Map<string, AgentPrincipal>) {}

  static fromSpec(spec: JourneySpec): AgentRegistry {
    const p: AgentPrincipal = {
      identity: spec.agent.identity,
      persona: spec.agent.persona,
      privileges: spec.agent.privileges,
      dataScope: spec.agent.dataScope,
    };
    return new AgentRegistry(new Map([[p.identity, p]]));
  }

  get(identity: string): AgentPrincipal {
    const a = this.agents.get(identity);
    if (!a) throw new Error(`unknown agent: ${identity}`);
    return a;
  }

  /** Exact capability match. A prefix is never a grant. */
  authorize(principal: AgentPrincipal, capability: string): AuthzResult {
    for (const priv of principal.privileges) {
      const idx = priv.indexOf(":");
      const cap = idx === -1 ? priv : priv.slice(0, idx);
      if (cap === capability) {
        return idx === -1
          ? { allowed: true }
          : { allowed: true, scope: priv.slice(idx + 1) };
      }
    }
    return {
      allowed: false,
      reason: `agent ${principal.identity} holds no privilege for ${capability}`,
    };
  }

  /** Deny wins; unlisted resources are denied (allow-list, not deny-list). */
  canRead(principal: AgentPrincipal, resource: string): boolean {
    if (principal.dataScope.deny.includes(resource)) return false;
    return principal.dataScope.read.includes(resource);
  }
}
