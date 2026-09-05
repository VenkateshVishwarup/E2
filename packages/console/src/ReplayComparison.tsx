import { useEffect, useState, type ReactNode } from "react";
import { defaultPair } from "./useVersions.js";
import { VersionPicker } from "./VersionPicker.js";

interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  observedConversionByDecision: Record<string, number>;
  cost: { leads: number; extracted: number; reused: number; usd: number };
  divergent: Array<{
    leadId: string;
    a: { decision: string };
    b: { decision: string };
    actualOutcome: string | null;
  }>;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const COHORTS = [50, 200, 500, 1000, 2000];
const DEFAULT_COHORT = 200;

interface Estimate {
  available: number; leads: number; extracted: number;
  reused: number; estimatedUsd: number; modelled: boolean;
}

export function ReplayComparison(
  { journey, versions }: { journey: string; versions: number[] },
) {
  const pair = defaultPair(versions);
  const [a, setA] = useState(pair?.a ?? 0);
  const [b, setB] = useState(pair?.b ?? 0);

  // The picker starts empty until the versions arrive.
  useEffect(() => {
    const p = defaultPair(versions);
    if (p) { setA(p.a); setB(p.b); }
  }, [versions]);

  const [lift, setLift] = useState<Lift | null>(null);
  const [estimate, setEstimate] = useState<Estimate | null>(null);
  const [n, setN] = useState(DEFAULT_COHORT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Estimating is free. Running is not, so nothing runs until asked.
  useEffect(() => {
    if (!a || !b) return;
    setLift(null); setError(null);
    void (async () => {
      const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/replay-estimate` +
                            `?a=${a}&b=${b}&n=${n}`);
      if (r.ok) setEstimate(await r.json());
    })();
  }, [journey, a, b, n]);

  const run = async () => {
    setBusy(true); setError(null); setLift(null);
    try {
      const r = await fetch("/api/replay", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, a, b, n }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setLift(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  if (versions.length < 2) {
    return <p className="muted">Replay compares two versions; publish another one first.</p>;
  }

  const controls = (
    <>
      <p className="muted">
        Take leads that already happened and ask what a different version would have done
        with them.
      </p>
      <div className="pickers">
        <VersionPicker label="baseline" versions={versions} value={a} onChange={setA} exclude={b} disabled={busy} />
        <VersionPicker label="candidate" versions={versions} value={b} onChange={setB} exclude={a} disabled={busy} />
        <label className="picker">
          <span className="picker-label">cohort</span>
          <select value={n} disabled={busy} onChange={(e) => setN(Number(e.target.value))}>
            {COHORTS.map((c) => <option key={c} value={c}>{c.toLocaleString()} leads</option>)}
          </select>
        </label>
      </div>

      {/* A screen that can spend money must say so before it does. */}
      {estimate && (
        <p className="muted">
          {estimate.reused.toLocaleString()} of {estimate.leads.toLocaleString()} already
          carry their evidence and cost nothing.{" "}
          {estimate.extracted === 0
            ? "Nothing needs re-extracting, so this replay is free."
            : estimate.modelled
              ? `${estimate.extracted.toLocaleString()} need a model call — about $${estimate.estimatedUsd.toFixed(2)}.`
              : `${estimate.extracted.toLocaleString()} need extraction, free on the offline extractor.`}
          {" "}{estimate.available.toLocaleString()} leads available in total.
        </p>
      )}

      <button className="btn" disabled={busy || !a || !b} onClick={() => void run()}>
        {busy ? "Replaying…" : `Replay v${a} against v${b}`}
      </button>
    </>
  );

  if (error) return <>{controls}<p className="err">Replay failed: {error}</p></>;
  if (!lift) return controls;

  return (
    <>
      {controls}
      <p className="muted">
        {lift.n.toLocaleString()} historical leads ·{" "}
        {lift.cost.extracted === 0
          ? "no model calls needed"
          : `${lift.cost.extracted.toLocaleString()} extractions, $${lift.cost.usd.toFixed(4)}`}
      </p>

      <div className="arms">
        <Arm label={`v${lift.a.version} (current)`} rate={lift.a.qualifiedRate} />
        <Arm label={`v${lift.b.version} (candidate)`} rate={lift.b.qualifiedRate} />
      </div>

      <p className="headline">
        <strong>{lift.absoluteLift >= 0 ? "+" : ""}{pct(lift.absoluteLift)}</strong>{" "}
        qualification rate{" "}
        <span className="muted">
          (95% CI {pct(lift.ci95[0])} to {pct(lift.ci95[1])})
        </span>
      </p>

      {/* Observed and modelled are rendered differently on purpose. Blurring
          the two is the fastest way to lose a room. */}
      <Band kind="observed" title="Observed — measured from history">
        <ul>
          {Object.entries(lift.observedConversionByDecision).map(([d, r]) => (
            <li key={d}>{d}: {pct(r)} converted</li>
          ))}
        </ul>
      </Band>

      <Band kind="modelled" title="Modelled — projected from those observed rates">
        <p>
          v{lift.a.version}: {lift.a.projectedConversions.toFixed(1)} conversions ·{" "}
          v{lift.b.version}: {lift.b.projectedConversions.toFixed(1)} conversions
        </p>
      </Band>

      <h2>Diverged on {lift.divergent.length} leads</h2>
      <div className="scroll">
        <table>
          <thead>
            <tr>
              <th>Lead</th><th>v{lift.a.version}</th><th>v{lift.b.version}</th><th>Actually</th>
            </tr>
          </thead>
          <tbody>
            {lift.divergent.slice(0, 60).map((d) => (
              <tr key={d.leadId}>
                <td><code>{d.leadId}</code></td>
                <td>{d.a.decision}</td>
                <td>{d.b.decision}</td>
                <td>{d.actualOutcome ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Arm({ label, rate }: { label: string; rate: number }) {
  return (
    <div className="arm">
      <div className="arm-label">{label}</div>
      <div className="arm-rate">{pct(rate)}</div>
      <div className="arm-label">qualified</div>
    </div>
  );
}

function Band({ kind, title, children }: { kind: "observed" | "modelled"; title: string; children: ReactNode }) {
  return (
    <section className={`band ${kind}`}>
      <h3>{title}</h3>
      {children}
    </section>
  );
}
