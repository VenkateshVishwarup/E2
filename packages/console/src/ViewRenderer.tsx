export type View =
  | { kind: "bar"; title: string; unit?: string;
      series: Array<{ label: string; value: number; band?: "observed" | "modelled" }> }
  | { kind: "table"; title: string; columns: string[]; rows: Array<Array<string | number | null>> }
  | { kind: "stat"; title: string; value: string; caption?: string };

/**
 * The console renders a descriptor the copilot chose from a closed set. The
 * model never sends markup, so there is nothing here to sanitise — every value
 * below lands in a text node or a width, never in HTML.
 */
/** Small values still need to read as numbers, not as "0". */
const format = (v: number) =>
  Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) < 1 ? 3 : 1);

export function ViewRenderer({ view }: { view: View }) {
  if (view.kind === "stat") {
    return (
      <div className="metric" style={{ marginTop: 16 }}>
        <div className="metric-label">{view.title}</div>
        <div className="metric-value">{view.value}</div>
        {view.caption && <div className="metric-label">{view.caption}</div>}
      </div>
    );
  }

  if (view.kind === "table") {
    return (
      <div className="scroll" style={{ marginTop: 16 }}>
        <h3 className="view-title">{view.title}</h3>
        <table>
          <thead><tr>{view.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
          <tbody>
            {view.rows.map((row, i) => (
              <tr key={i}>{row.map((cell, j) => <td key={j}>{cell ?? "—"}</td>)}</tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }

  const max = Math.max(...view.series.map((s) => Math.abs(s.value)), Number.EPSILON);
  return (
    <div style={{ marginTop: 16 }}>
      <h3 className="view-title">{view.title}</h3>
      {view.series.map((s) => (
        <div className="bar-row" key={s.label}>
          <div className="bar-label">{s.label}</div>
          <div className="bar-track">
            <div
              className={`bar-fill ${s.band ?? "observed"}`}
              style={{ width: `${(Math.abs(s.value) / max) * 100}%` }}
            />
          </div>
          <div className="bar-value">{format(s.value)}{view.unit ?? ""}</div>
        </div>
      ))}
    </div>
  );
}
