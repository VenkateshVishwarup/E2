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
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then(setLift)
      .catch((e: Error) => setError(e.message));
  }, [journey, a, b]);

  if (error) return <p style={{ color: "#b00" }}>Replay failed: {error}</p>;
  if (!lift) return <p>Replaying…</p>;

  return (
    <>
      <p style={{ color: "#555" }}>{lift.n.toLocaleString()} historical leads</p>

      <div style={{ display: "flex", gap: 24, margin: "24px 0" }}>
        <Arm label={`v${lift.a.version} (current)`} rate={lift.a.qualifiedRate} />
        <Arm label={`v${lift.b.version} (candidate)`} rate={lift.b.qualifiedRate} />
      </div>

      <p style={{ fontSize: 18 }}>
        <strong>{lift.absoluteLift >= 0 ? "+" : ""}{pct(lift.absoluteLift)}</strong>{" "}
        qualification rate
        <span style={{ color: "#555" }}>
          {" "}(95% CI {pct(lift.ci95[0])} to {pct(lift.ci95[1])})
        </span>
      </p>

      {/* Observed and modelled are rendered differently on purpose. Blurring
          the two is the fastest way to lose a room. */}
      <Section title="Observed — measured from history" tone="#0a7d55">
        <ul>
          {Object.entries(lift.observedConversionByDecision).map(([d, r]) => (
            <li key={d}>{d}: {pct(r)} converted</li>
          ))}
        </ul>
      </Section>

      <Section title="Modelled — projected from those observed rates" tone="#a66300">
        <p>
          v{lift.a.version}: {lift.a.projectedConversions.toFixed(1)} conversions ·{" "}
          v{lift.b.version}: {lift.b.projectedConversions.toFixed(1)} conversions
        </p>
      </Section>

      <h2 style={{ fontSize: 15 }}>Diverged on {lift.divergent.length} leads</h2>
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr style={{ textAlign: "left", borderBottom: "1px solid #ddd" }}>
            <th>Lead</th><th>v{lift.a.version}</th><th>v{lift.b.version}</th><th>Actually</th>
          </tr>
        </thead>
        <tbody>
          {lift.divergent.slice(0, 60).map((d) => (
            <tr key={d.leadId} style={{ borderBottom: "1px solid #f0f0f0" }}>
              <td><code>{d.leadId}</code></td>
              <td>{d.a.decision}</td>
              <td>{d.b.decision}</td>
              <td>{d.actualOutcome ?? "—"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}

function Arm({ label, rate }: { label: string; rate: number }) {
  return (
    <div style={{ flex: 1, border: "1px solid #ddd", borderRadius: 8, padding: 16 }}>
      <div style={{ color: "#555", fontSize: 12 }}>{label}</div>
      <div style={{ fontSize: 28 }}>{pct(rate)}</div>
      <div style={{ color: "#555", fontSize: 12 }}>qualified</div>
    </div>
  );
}

function Section({ title, tone, children }: { title: string; tone: string; children: ReactNode }) {
  return (
    <section style={{ borderLeft: `3px solid ${tone}`, paddingLeft: 12, margin: "20px 0" }}>
      <h3 style={{ fontSize: 13, color: tone, margin: "0 0 4px" }}>{title}</h3>
      {children}
    </section>
  );
}
