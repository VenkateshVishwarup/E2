import { useEffect, useState } from "react";
import { VersionPicker } from "./VersionPicker.js";
import { useLimits } from "./useVersions.js";

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

interface SpecWarning { code: string; message: string }

export function SimulateRun({ journey, versions }: { journey: string; versions: number[] }) {
  const { maxCohort } = useLimits();
  const cohort = Math.min(200, maxCohort);
  const [version, setVersion] = useState(0);
  useEffect(() => { if (versions[0] !== undefined) setVersion(versions[0]); }, [versions]);

  const [result, setResult] = useState<Result | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<SpecWarning[]>([]);

  // Static checks, before anything is run. A version that cannot qualify anyone
  // reports 0% qualified, and a 0% with no explanation reads as broken software
  // rather than as the broken spec it is.
  useEffect(() => {
    void (async () => {
      try {
        if (!version) return;
        const r = await fetch(
          `/api/journeys/${encodeURIComponent(journey)}/lint?version=${version}`);
        if (r.ok) setWarnings((await r.json()).warnings ?? []);
      } catch { /* the lint is advisory; never block the run on it */ }
    })();
  }, [journey, version]);

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
        Drive synthetic leads through a version before a real one ever touches it.
      </p>
      <div className="pickers">
        <VersionPicker label="version" versions={versions} value={version}
                       onChange={(v) => { setVersion(v); setResult(null); }} disabled={busy} />
      </div>
      {warnings.length > 0 && (
        <div className="band modelled">
          <h3>Static check — before anything runs</h3>
          {warnings.map((w) => (
            <div className="alert warn" key={w.code}>{w.message}</div>
          ))}
        </div>
      )}

      <button className="btn" disabled={busy || !version} onClick={() => void go(cohort)}>
        {busy ? "Simulating…" : `Simulate ${cohort} leads through v${version || "?"}`}
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
