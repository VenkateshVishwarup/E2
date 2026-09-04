import { useEffect, useState } from "react";

interface Totals {
  leads: number;
  counts: Record<string, number>;
  sums: Record<string, number>;
  mediaCost: number;
  modelCost: number;
  totalCost: number;
  costPer: Record<string, number | null>;
  returnOnSpend: Record<string, number | null>;
}

interface Node extends Totals {
  dimension: "campaign" | "creative" | "version";
  value: string;
  children: Node[];
}

interface Report {
  journey: string;
  currency: string;
  metricKinds: { booleans: string[]; aggregates: string[] };
  total: Totals;
  tree: Node[];
  caveats: string[];
}

/** Amounts are integer minor units the whole way through. */
const money = (v: number | null | undefined, currency: string) =>
  v === null || v === undefined
    ? "—"
    : new Intl.NumberFormat("en-IN", { style: "currency", currency, maximumFractionDigits: 0 })
        .format(v / 100);

function flatten(nodes: Node[], depth = 0): Array<{ node: Node; depth: number }> {
  return nodes.flatMap((node) => [{ node, depth }, ...flatten(node.children, depth + 1)]);
}

export function Roi({ journey }: { journey: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/roi`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        setReport(await r.json());
      } catch (e) { setError((e as Error).message); }
    })();
  }, [journey]);

  if (error) return <p className="err">Could not load ROI: {error}</p>;
  if (!report) return <p className="muted">Folding the event log…</p>;

  const { total, currency } = report;
  const rows = flatten(report.tree);

  return (
    <>
      <p className="muted">
        Every figure here is a fold over the same event log the other tabs read. There is no
        separate attribution pipeline to drift out of sync.
      </p>

      <div className="metrics">
        <div className="metric">
          <div className="metric-label">leads</div>
          <div className="metric-value">{total.leads}</div>
        </div>
        {report.metricKinds.booleans.map((m) => (
          <div className="metric" key={m}>
            <div className="metric-label">{m.replace(/_/g, " ")}</div>
            <div className="metric-value">{total.counts[m] ?? 0}</div>
          </div>
        ))}
        <div className="metric">
          <div className="metric-label">cost / conversion</div>
          <div className="metric-value">{money(total.costPer.conversion, currency)}</div>
        </div>
      </div>

      {/* Media spend is an allocated number; model spend is metered from token
          usage. The M1 observed/modelled split applies here too. */}
      <div className="band observed">
        <h3>Observed — metered</h3>
        <p>
          Model spend {money(total.modelCost, currency)} · revenue{" "}
          {money(total.sums.revenue ?? 0, currency)} from {total.counts.conversion ?? 0} conversions
        </p>
      </div>
      <div className="band modelled">
        <h3>Modelled — allocated</h3>
        <p>
          Media spend {money(total.mediaCost, currency)}, distributed evenly across the leads
          each campaign produced that day
        </p>
      </div>

      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>campaign → creative → version</th>
              <th>leads</th>
              {report.metricKinds.booleans.map((m) => <th key={m}>{m.replace(/_/g, " ")}</th>)}
              <th>spend</th>
              <th>cost / conversion</th>
              <th>revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ node, depth }) => (
              <tr key={`${depth}-${node.dimension}-${node.value}-${node.leads}`}>
                <td style={{ paddingLeft: 8 + depth * 18 }}>
                  {depth > 0 && <span className="muted">↳ </span>}
                  {node.dimension === "version" ? `v${node.value}` : node.value}
                </td>
                <td>{node.leads}</td>
                {report.metricKinds.booleans.map((m) => <td key={m}>{node.counts[m] ?? 0}</td>)}
                <td>{money(node.totalCost, currency)}</td>
                <td>{money(node.costPer.conversion, currency)}</td>
                <td>{money(node.sums.revenue ?? 0, currency)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Assumptions belong beside the numbers, not in an appendix. */}
      {report.caveats.length > 0 && (
        <div className="band">
          <h3>What these numbers assume</h3>
          <ul>{report.caveats.map((c) => <li key={c} className="muted">{c}</li>)}</ul>
        </div>
      )}
    </>
  );
}
