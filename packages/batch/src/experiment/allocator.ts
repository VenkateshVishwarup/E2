import { createHash } from "node:crypto";

export interface Arm { target: string; weight: number }
export interface Allocation { source: string; arms: Arm[] }

/**
 * Binds a traffic source to weighted targets.
 *
 * `target` is opaque on purpose. "journey@4" vs "journey@5" is an A/B test;
 * "journey@5" vs "external:engati" is a parallel run against the existing
 * platform. Same primitive, both stories — which is why adoption can be a
 * parallel run rather than a cutover.
 */
export class TrafficAllocator {
  private readonly bySource = new Map<string, Arm[]>();

  constructor(allocations: Allocation[]) {
    for (const a of allocations) {
      const total = a.arms.reduce((s, x) => s + x.weight, 0);
      if (total !== 100) {
        throw new Error(`allocation for "${a.source}" must sum to 100, got ${total}`);
      }
      this.bySource.set(a.source, a.arms);
    }
  }

  /**
   * Deterministic: the same lead always lands in the same arm, so re-running an
   * experiment does not reshuffle the cohort. The source is mixed into the hash
   * so separate experiments are uncorrelated — otherwise a lead unlucky in one
   * would be unlucky in all of them.
   */
  allocate(source: string, key: string): string {
    const arms = this.bySource.get(source);
    if (!arms) throw new Error(`no allocation configured for source "${source}"`);

    const digest = createHash("sha256").update(`${source}:${key}`).digest();
    const bucket = digest.readUInt32BE(0) % 100;

    let cumulative = 0;
    for (const arm of arms) {
      cumulative += arm.weight;
      if (bucket < cumulative) return arm.target;
    }
    return arms[arms.length - 1]!.target;
  }

  split(source: string, keys: string[]): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const arm of this.bySource.get(source) ?? []) out[arm.target] = [];
    for (const key of keys) (out[this.allocate(source, key)] ??= []).push(key);
    return out;
  }
}
