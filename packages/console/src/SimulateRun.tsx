import { useState } from "react";

interface Alert { id: string; severity: "warn" | "critical"; message: string }
interface Quality {
  n: number; meanCompleteness: number; meanCorrectness: number | null;
  violationRate: number; hallucinationRate: number; ghostRate: number;
  escalationRate: number; qualifiedRate: number; meanTurns: number;
}
interface Result {
  summary: { runId: string; n: number; completed: number; qualified: number;
             escalated: number; ghosted: number; avgTurns: number };
  quality: Quality;
  alerts: Alert[];
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function SimulateRun({ journey, version }: { journey: string; version: number }) {
  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async (n: number) => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/simulate", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, version, n }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setResult(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        Drive synthetic leads through v{version} before a real one ever touches it.
      </p>
      <button className="btn" disabled={busy} onClick={() => void go(200)}>
        {busy ? "Simulating…" : "Simulate 200 leads"}
      </button>

      {error && <p className="err">Simulation failed: {error}</p>}

      {result && (
        <>
          <h2>Quality</h2>
          <div className="metrics">
            <Metric label="Evidence completeness" value={pct(result.quality.meanCompleteness)} />
            <Metric label="Evidence correctness"
                    value={result.quality.meanCorrectness === null ? "—" : pct(result.quality.meanCorrectness)} />
            <Metric label="Qualified" value={pct(result.quality.qualifiedRate)} />
            <Metric label="Ghosted" value={pct(result.quality.ghostRate)} />
            <Metric label="Escalated" value={pct(result.quality.escalationRate)} />
            <Metric label="Mean turns" value={result.quality.meanTurns.toFixed(1)} />
          </div>

          <h2>Alerts</h2>
          {result.alerts.length === 0
            ? <p className="ok">No thresholds breached.</p>
            : result.alerts.map((a) => (
                <div key={a.id} className={`alert ${a.severity}`}>
                  <strong>{a.severity.toUpperCase()}</strong> — {a.message}
                </div>
              ))}
        </>
      )}
    </>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
    </div>
  );
}
