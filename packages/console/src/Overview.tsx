import { useEffect, useState } from "react";
import { money, rate } from "./format.js";

interface Totals {
  leads: number;
  counts: Record<string, number>;
  sums: Record<string, number>;
  modelCost: number;
  mediaCost: number;
  totalCost: number;
  costPer: Record<string, number | null>;
}
interface Report { currency: string; total: Totals; metricKinds: { booleans: string[] } }
interface Finding { code: string; severity: string; claim: string; n: number }
interface Insights { leadsAnalysed: number; findings: Finding[] }

export function Overview(
  { journey, versions, onGo }: {
    journey: string; versions: number[]; onGo: (tab: string) => void;
  },
) {
  const [roi, setRoi] = useState<Report | null>(null);
  const [insights, setInsights] = useState<Insights | null>(null);
  const [live, setLive] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const j = encodeURIComponent(journey);
        const [r, i] = await Promise.all([
          fetch(`/api/journeys/${j}/roi`), fetch(`/api/journeys/${j}/insights`),
        ]);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        setRoi(await r.json());
        if (i.ok) setInsights(await i.json());
      } catch (e) { setError((e as Error).message); }
    })();
  }, [journey]);

  // Real conversations are the ones that arrived through chat rather than an
  // import, which is the number that says whether anyone is actually using it.
  useEffect(() => {
    void (async () => {
      const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/insights`);
      if (r.ok) setLive((await r.json()).leadsAnalysed);
    })();
  }, [journey]);

  if (error) return <p className="err">Could not load: {error}</p>;
  if (!roi) return <p className="muted">Reading the event log…</p>;

  const { total, currency } = roi;
  const nothingYet = total.leads === 0;

  if (nothingYet) {
    return (
      <div className="empty">
        <h2>Nothing has happened yet</h2>
        <p className="muted">
          There are no conversations on this journey. Write the contract, publish it, and
          talk to it — that loop takes about a minute.
        </p>
        <div className="ask">
          <button className="btn" onClick={() => onGo("Journey")}>Open the journey</button>
          <button className="btn" onClick={() => onGo("Chat")}>Start a conversation</button>
        </div>
      </div>
    );
  }

  const qualified = total.counts.qualified_lead ?? 0;
  const converted = total.counts.conversion ?? 0;

  return (
    <>
      <p className="muted">
        Journey <code>{journey}</code> · v{versions[0] ?? "—"} is live ·{" "}
        {versions.length} version{versions.length === 1 ? "" : "s"} published
      </p>

      <div className="metrics">
        <Metric label="conversations" value={total.leads.toLocaleString()} />
        <Metric label="qualified" value={qualified.toLocaleString()}
                note={rate(qualified, total.leads)} />
        <Metric label="converted" value={converted.toLocaleString()}
                note={rate(converted, total.leads)} />
        <Metric label="model spend" value={money(total.modelCost, currency)}
                note={total.modelCost === 0 ? "no model calls yet" : undefined} />
        <Metric label="model cost / qualified"
                value={qualified === 0 ? "—" : money(total.modelCost / qualified, currency)} />
        <Metric label="revenue" value={money(total.sums.revenue ?? 0, currency)} />
      </div>

      {insights && insights.findings.length > 0 && (
        <>
          <h2>What the data is telling you</h2>
          {insights.findings.slice(0, 3).map((f) => (
            <div className={`alert ${f.severity === "high" ? "critical" : "warn"}`} key={f.code + f.claim}>
              <strong>{f.code.replace(/_/g, " ")}</strong>
              <div>{f.claim}</div>
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>n = {f.n.toLocaleString()}</div>
            </div>
          ))}
          <button className="btn" onClick={() => onGo("Findings")}>
            All {insights.findings.length} findings
          </button>
        </>
      )}

      {/* Every screen here reads the same log. Say it once, on the screen
          people land on, rather than repeating it on each. */}
      <p className="muted provenance" style={{ marginTop: 24 }}>
        Every figure on every screen is a fold over one append-only event log. There is no
        separate analytics pipeline to drift out of sync.
        {live !== null && total.modelCost === 0 &&
          " Model spend is zero because these conversations were imported or seeded, not held."}
      </p>
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note && <div className="metric-label">{note}</div>}
    </div>
  );
}
