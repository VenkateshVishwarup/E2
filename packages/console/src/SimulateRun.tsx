import { useEffect, useState } from "react";
import { VersionPicker } from "./VersionPicker.js";
import { useLimits } from "./useVersions.js";
import { spread } from "./format.js";

interface Alert { id: string; severity: "warn" | "critical"; message: string }
interface Quality {
  n: number; meanCompleteness: number; meanCorrectness: number | null;
  violationRate: number; hallucinationRate: number; ghostRate: number;
  escalationRate: number; qualifiedRate: number; meanTurns: number;
}
interface Range { min: number; max: number; mean: number }
interface Variance {
  repeats: number;
  identical: boolean;
  ranges: Partial<Record<keyof Quality, Range | null>>;
  alertFrequency: Record<string, number>;
  runs: Array<{ runId: string; alerts: Alert[] }>;
}
interface Result {
  summary: { runId: string; n: number; completed: number; qualified: number;
             escalated: number; ghosted: number; avgTurns: number };
  quality: Quality;
  alerts: Alert[];
  variance?: Variance;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
const turns = (v: number) => v.toFixed(1);

/** Odd counts, so the middle repeat is a real run rather than an average of two. */
const REPEAT_CHOICES = [1, 3, 5];

interface SpecWarning { code: string; message: string }

export function SimulateRun({ journey, versions }: { journey: string; versions: number[] }) {
  const { maxCohort, maxRepeats, offline } = useLimits();
  const [repeats, setRepeats] = useState(1);
  const repeatChoices = REPEAT_CHOICES.filter((r) => r <= maxRepeats);
  // The ceiling is on conversations billed, so repeating shrinks the cohort
  // rather than multiplying the bill.
  const cohort = Math.max(1, Math.min(200, Math.floor(maxCohort / repeats)));
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
        body: JSON.stringify({ journey, version, n, repeats }),
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
        {repeatChoices.length > 1 && (
          <label className="picker">
            <span className="picker-label">repeats</span>
            <select value={repeats} disabled={busy}
                    onChange={(e) => { setRepeats(Number(e.target.value)); setResult(null); }}>
              {repeatChoices.map((r) => (
                <option key={r} value={r}>{r === 1 ? "once" : `${r}× the same leads`}</option>
              ))}
            </select>
          </label>
        )}
      </div>
      {repeats > 1 && (
        <p className="muted provenance">
          Runs the same personas {repeats} times. An agent that may not take the same path
          twice has a range of outcomes, not one, and a single run is a sample of it.
        </p>
      )}
      {warnings.length > 0 && (
        <div className="band modelled">
          <h3>Static check — before anything runs</h3>
          {warnings.map((w) => (
            <div className="alert warn" key={w.code}>{w.message}</div>
          ))}
        </div>
      )}

      <button className="btn" disabled={busy || !version} onClick={() => void go(cohort)}>
        {busy ? "Simulating…"
          : `Simulate ${cohort} leads${repeats > 1 ? ` × ${repeats}` : ""} through v${version || "?"}`}
      </button>

      {error && <p className="err">Simulation failed: {error}</p>}

      {result && <Results result={result} offline={offline} />}
    </>
  );
}

const FIGURES: Array<{ key: keyof Quality; label: string; fmt: (v: number) => string }> = [
  { key: "meanCompleteness", label: "Evidence completeness", fmt: pct },
  { key: "meanCorrectness", label: "Evidence correctness", fmt: pct },
  { key: "qualifiedRate", label: "Qualified", fmt: pct },
  { key: "ghostRate", label: "Ghosted", fmt: pct },
  { key: "escalationRate", label: "Escalated", fmt: pct },
  { key: "meanTurns", label: "Mean turns", fmt: turns },
];

function Results({ result, offline }: { result: Result; offline: boolean }) {
  const v = result.variance;
  // Identical repeats are points, and drawing them as ranges would dress a
  // repetition up as a measurement.
  const ranged = v !== undefined && !v.identical;

  return (
    <>
      <h2>
        Quality
        {v && <span className="muted"> — {v.repeats} runs of the same {result.quality.n} leads</span>}
      </h2>

      {v?.identical && (
        <p className="muted">
          All {v.repeats} runs produced identical figures, so these are points rather than
          ranges.{" "}
          {offline
            ? "Offline, the extractor, the planner and the personas are all deterministic: " +
              "nothing in the loop can vary. With a model configured, this measures the " +
              "agent's spread."
            : "Nothing in this run varied."}
        </p>
      )}
      {ranged && (
        <div className="band modelled">
          <h3>A range, not a confidence interval</h3>
          <p>
            Each figure is the mean of {v.repeats} runs, with the lowest and highest beneath it.
            With a model in the loop even a deterministic version varies — extraction and the
            personas are model calls — so compare this width against a deterministic version's
            before crediting the difference to the agent's strategy.
          </p>
        </div>
      )}

      <div className="metrics">
        {FIGURES.map(({ key, label, fmt }) => {
          const range = ranged ? v.ranges[key] : undefined;
          const point = result.quality[key];
          const shown = range ? spread(range, fmt) : undefined;
          return (
            <Metric key={key} label={label}
                    value={range ? fmt(range.mean) : point === null ? "—" : fmt(point)}
                    note={shown === undefined ? undefined
                      : shown.includes("–") ? `range ${shown}` : "same every run"} />
          );
        })}
      </div>

      <h2>Alerts</h2>
      <AlertList result={result} />
    </>
  );
}

/**
 * Every alert that fired on any run. One that fires on some runs and not others
 * is the agent's variance showing up as risk — the thing a single run hides —
 * so it says how often rather than collapsing to fired / did not.
 */
function AlertList({ result }: { result: Result }) {
  const v = result.variance;
  const seen = new Map<string, Alert>();
  for (const run of v?.runs ?? [{ runId: "", alerts: result.alerts }]) {
    for (const a of run.alerts) if (!seen.has(a.id)) seen.set(a.id, a);
  }
  if (seen.size === 0) return <p className="ok">No thresholds breached.</p>;

  return (
    <>
      {[...seen.values()].map((a) => {
        const fired = v?.alertFrequency[a.id];
        return (
          <div key={a.id} className={`alert ${a.severity}`}>
            <strong>{a.severity.toUpperCase()}</strong> — {a.message}
            {v && fired !== undefined && (
              <span className="muted">
                {fired === v.repeats ? " · every run" : ` · ${fired} of ${v.repeats} runs`}
              </span>
            )}
          </div>
        );
      })}
    </>
  );
}

function Metric({ label, value, note }: { label: string; value: string; note?: string }) {
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value">{value}</div>
      {note && <div className="metric-range muted">{note}</div>}
    </div>
  );
}
