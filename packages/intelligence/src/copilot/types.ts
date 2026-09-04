import type { SpecWarning } from "@midfunnel/core/journey/spec";
import type { SpecChange } from "@midfunnel/core/journey/registry";

/**
 * A closed set of view kinds, chosen by the model but rendered by the console.
 * The model never emits markup: HTML from a model into the console DOM is an
 * XSS hole, whereas picking a chart type from a fixed list is the
 * conversational-rendering thesis without the hole.
 */
export type View =
  | {
      kind: "bar";
      title: string;
      unit?: string;
      /** `band` drives the observed/modelled colouring the console already uses. */
      series: Array<{ label: string; value: number; band?: "observed" | "modelled" }>;
    }
  | { kind: "table"; title: string; columns: string[]; rows: Array<Array<string | number | null>> }
  | { kind: "stat"; title: string; value: string; caption?: string };

export const VIEW_KINDS = ["bar", "table", "stat"] as const;

export interface ProposedDiff {
  journey: string;
  fromVersion: number;
  toVersion: number;
  rationale: string;
  /** The full proposed spec. Nothing is published; this is a proposal. */
  yaml: string;
  changes: SpecChange[];
  /** Lint output travels WITH the proposal. A warning hidden is a warning ignored. */
  warnings: SpecWarning[];
}

export interface Answer {
  text: string;
  view?: View;
  diff?: ProposedDiff;
  /** Which read models backed the claim. The audit trail for the answer. */
  usedTools: string[];
  /** True when produced without a model call, so nobody mistakes it for reasoning. */
  offline: boolean;
}
