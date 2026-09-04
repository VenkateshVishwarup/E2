import type { EventStore } from "@midfunnel/core/events/store";
import type { JourneyRegistry } from "@midfunnel/core/journey/registry";
import { CopilotTools } from "./tools.js";
import type { Answer, View } from "./types.js";

/**
 * A model-free copilot, for running the system with no credential.
 *
 * It routes by keyword rather than reasoning, and every answer is stamped
 * `offline: true` so nobody mistakes it for the real thing. What it does share
 * with the real copilot is the part that matters: the SAME tools, so the
 * numbers it reports are the numbers the screens report.
 */
export class OfflineCopilot {
  private readonly tools: CopilotTools;

  constructor(store: EventStore, registry: JourneyRegistry) {
    this.tools = new CopilotTools(store, registry);
  }

  async ask(journey: string, question: string): Promise<Answer> {
    const q = question.toLowerCase();
    if (/\b(roi|cost|spend|cac|revenue|budget)\b/.test(q)) return this.roi(journey);
    if (/\b(why|worse|better|cohort|segment|converting|drop)\b/.test(q)) return this.diagnose(journey, q);
    return this.overview(journey);
  }

  private async roi(journey: string): Promise<Answer> {
    const report = await this.tools.roi(journey);
    const { total } = report;
    const money = (v: number | null) => (v === null ? "n/a" : `₹${(v / 100).toFixed(0)}`);

    const view: View = {
      kind: "table",
      title: `Cost per outcome — ${report.journey}`,
      columns: ["campaign", "leads", "qualified", "converted", "spend", "cost / conversion"],
      rows: report.tree.map((n) => [
        n.value, n.leads, n.counts.qualified_lead ?? 0, n.counts.conversion ?? 0,
        money(n.totalCost), money(n.costPer.conversion ?? null),
      ]),
    };

    return {
      text: `${total.leads} leads cost ${money(total.totalCost)} in total ` +
            `(${money(total.mediaCost)} media, ${money(total.modelCost)} model). ` +
            `${total.counts.conversion ?? 0} converted, so ${money(total.costPer.conversion ?? null)} ` +
            `per conversion. ${report.caveats[0] ?? ""}`.trim(),
      view,
      usedTools: ["roi"],
      offline: true,
    };
  }

  private async diagnose(journey: string, q: string): Promise<Answer> {
    const report = await this.tools.insights(journey);
    const divergences = report.findings.filter((f) => f.code === "segment_divergence");
    // Prefer a dimension the question actually mentions, so "why is Bangalore
    // converting worse" is answered about Bangalore rather than about whatever
    // happens to rank first.
    const finding = divergences.find((f) => q.includes(String(f.evidence.value).toLowerCase()))
      ?? divergences[0] ?? report.findings[0];

    if (!finding) {
      return {
        text: `Nothing in ${report.leadsAnalysed} leads clears the significance bar. ` +
              (report.skipped[0] ? `Detectors skipped: ${report.skipped[0].reason}` : ""),
        usedTools: ["insights"], offline: true,
      };
    }

    const usedTools = ["insights"];
    let view: View | undefined;
    let diff;

    const dimension = finding.evidence.dimension as string | undefined;
    if (dimension) {
      const breakdown = await this.tools.cohort(journey, dimension);
      usedTools.push("cohort");
      view = {
        kind: "bar",
        title: `Conversion by ${dimension}`,
        unit: "%",
        series: breakdown.rows.map((r) => ({
          label: `${r.value} (n=${r.leads})`,
          value: Math.round(r.rate * 1000) / 10,
          band: "observed" as const,
        })),
      };
    }

    // Only an evidence dimension has a branchable proposal: you cannot add a
    // routing rule on "campaign", because the runtime never sees one.
    const field = dimension?.startsWith("evidence.") ? dimension.slice("evidence.".length) : null;
    if (field && finding.evidence.value) {
      const value = String(finding.evidence.value);
      const { yaml } = await this.tools.readSpec(journey);
      usedTools.push("read_spec");
      try {
        diff = await this.tools.proposeDiff(
          journey,
          addBranch(yaml, field, value),
          `${field} = ${value} converts ${(finding.effect * 100).toFixed(1)}% worse ` +
          `on the shared score; give it its own branch instead.`,
        );
        usedTools.push("propose_diff");
      } catch {
        // A proposal that will not validate is not offered. Same gate as the
        // model path — it just has no second attempt to make.
      }
    }

    return {
      text: `${finding.claim} ${finding.detail}.` +
            (finding.suggestion ? ` ${finding.suggestion}` : ""),
      ...(view ? { view } : {}),
      ...(diff ? { diff } : {}),
      usedTools, offline: true,
    };
  }

  private async overview(journey: string): Promise<Answer> {
    const report = await this.tools.insights(journey);
    return {
      text: report.findings.length === 0
        ? `No finding in ${report.leadsAnalysed} leads clears the significance bar.`
        : `${report.findings.length} findings over ${report.leadsAnalysed} leads. ` +
          `Highest: ${report.findings[0]!.claim}`,
      view: {
        kind: "table",
        title: "Findings",
        columns: ["severity", "finding", "n"],
        rows: report.findings.map((f) => [f.severity, f.claim, String(f.n)]),
      },
      usedTools: ["insights"], offline: true,
    };
  }
}

/**
 * Inserts a routing branch as the FIRST rule. Order is load-bearing — routing
 * is first-match-wins — so appending it would leave the cohort routed exactly
 * as it is today and the proposal would change nothing.
 */
export function addBranch(yaml: string, field: string, value: string): string {
  const bumped = yaml.replace(/^version:\s*(\d+)/m, (_, n: string) => `version: ${Number(n) + 1}`);
  const lines = bumped.split("\n");
  const at = lines.findIndex((l) => /^routing:\s*$/.test(l));
  if (at === -1) throw new Error("cannot add a branch: the spec has no routing block");

  const indent = /^(\s+)/.exec(lines[at + 1] ?? "  ")?.[1] ?? "  ";
  const name = `${value}_branch`.replace(/[^a-z0-9_]/gi, "_").toLowerCase();
  lines.splice(at + 1, 0,
    `${indent}${name}: { when: "evidence.${field} == ${value}", target: "nurture.${name}" }`);
  return lines.join("\n");
}
