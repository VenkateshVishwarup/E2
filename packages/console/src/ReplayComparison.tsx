import { useEffect, useState, type ReactNode } from "react";

interface Lift {
  n: number;
  a: { version: number; qualifiedRate: number; projectedConversions: number };
  b: { version: number; qualifiedRate: number; projectedConversions: number };
  absoluteLift: number;
  ci95: [number, number];
  observedConversionByDecision: Record<string, number>;
  divergent: Array<{
    leadId: string;
    a: { decision: string };
    b: { decision: string };
    actualOutcome: string | null;
  }>;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

export function ReplayComparison({ journey, a, b }: { journey: string; a: number; b: number }) {
  const [lift, setLift] = useState<Lift | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/replay", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ journey, a, b }),
    })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        return r.json();
      })
      .then(setLift)
      .catch((e: Error) => setError(e.message));
  }, [journey, a, b]);

  if (error) return <p className="err">Replay failed: {error}</p>;
  if (!lift) return <p className="muted">Replaying…</p>;

  return (
    <>
      <p className="muted">{lift.n.toLocaleString()} historical leads</p>

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
