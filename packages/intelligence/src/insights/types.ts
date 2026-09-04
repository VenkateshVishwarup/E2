export const FINDING_CODES = [
  "evidence_bottleneck", "segment_divergence", "drop_off",
  "routing_miscalibration", "timing", "policy_friction", "version_regression",
] as const;

export type FindingCode = (typeof FINDING_CODES)[number];
export type Severity = "high" | "medium" | "low";

export interface Finding {
  code: FindingCode;
  severity: Severity;
  /** One sentence a marketer can read without translation. */
  claim: string;
  /** The numbers behind the claim. */
  detail: string;
  /** Support. A finding without it is an anecdote. */
  n: number;
  /** Magnitude, used for ranking. Absolute difference in rates where relevant. */
  effect: number;
  /** Present on every comparison finding. A point estimate alone invites the
   *  challenge it cannot survive. */
  ci95?: [number, number];
  /** What to change in the spec, when there is a defensible answer. */
  suggestion?: string;
  evidence: Record<string, unknown>;
}

/**
 * Below this, a difference is noise. Noise presented to a CMO is worse than
 * silence, because it costs credibility that the real findings then need.
 */
export const MIN_SUPPORT = 30;

export interface InsightReport {
  journey: string;
  leadsAnalysed: number;
  findings: Finding[];
  /** Detectors that could not run, and why. Silence would look like a clean bill. */
  skipped: Array<{ code: FindingCode; reason: string }>;
}
