import { useEffect, useState } from "react";

interface Finding {
  code: string; severity: "high" | "medium" | "low";
  claim: string; detail: string; n: number; effect: number;
  ci95?: [number, number]; suggestion?: string;
}
interface Report {
  leadsAnalysed: number;
  findings: Finding[];
  skipped: Array<{ code: string; reason: string }>;
}

export function Insights({ journey }: { journey: string }) {
  const [report, setReport] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/insights`);
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
        setReport(await r.json());
      } catch (e) { setError((e as Error).message); }
    })();
  }, [journey]);

  if (error) return <p className="err">Could not load insights: {error}</p>;
  if (!report) return <p className="muted">Looking for patterns…</p>;

  return (
    <>
      <p className="muted">
        Seven detectors over {report.leadsAnalysed.toLocaleString()} leads. Every comparison
        carries a 95% interval, and a finding whose interval spans zero is not shown at
        all — noise in front of a marketer costs the credibility the real findings need.
      </p>

      {report.findings.length === 0 && (
        <p className="ok">Nothing clears the significance bar. That is a result, not a gap.</p>
      )}

      {report.findings.map((f) => (
        <div className="finding" key={f.code + f.claim}>
          <div className="finding-head">
            <span className={`sev ${f.severity}`}>{f.severity}</span>
            <code>{f.code.replace(/_/g, " ")}</code>
            <span className="muted">n = {f.n.toLocaleString()}</span>
          </div>
          <p className="finding-claim">{f.claim}</p>
          <p className="muted">{f.detail}</p>
          {f.suggestion && <p className="finding-do">→ {f.suggestion}</p>}
        </div>
      ))}

      {/* A detector that silently returns nothing reads as a clean bill of
          health, which is the opposite of the truth when it simply could not run. */}
      {report.skipped.length > 0 && (
        <>
          <h2>Could not run</h2>
          {report.skipped.map((s) => (
            <p className="muted" key={s.code}>
              <code>{s.code.replace(/_/g, " ")}</code> — {s.reason}
            </p>
          ))}
        </>
      )}
    </>
  );
}
