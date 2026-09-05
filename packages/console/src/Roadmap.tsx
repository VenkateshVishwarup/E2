import { ROADMAP, type RoadmapItem } from "./roadmap-data.js";

const HORIZONS: Array<{ key: RoadmapItem["horizon"]; label: string; note: string }> = [
  { key: "next", label: "Next", note: "The nearest gaps between this and a product you could sell" },
  { key: "planned", label: "Planned", note: "Designed for, with the groundwork already in place" },
  { key: "later", label: "Later", note: "Deliberately deferred — real, but not what the first customer needs" },
];

export function Roadmap() {
  return (
    <>
      <p className="muted">
        What this does not do yet, named rather than implied. Each item says what is already
        in place, because the distinction that matters is between a missing screen and a
        missing foundation — and almost all of these are the former.
      </p>

      {HORIZONS.map(({ key, label, note }) => (
        <section key={key}>
          <h2>{label}</h2>
          <p className="muted">{note}</p>
          {ROADMAP.filter((r) => r.horizon === key).map((r) => (
            <div className="finding" key={r.id}>
              <div className="finding-head">
                <span className={`sev ${key === "next" ? "medium" : "low"}`}>coming soon</span>
                <strong>{r.title}</strong>
              </div>
              <p className="finding-claim">{r.will}</p>
              <p className="muted"><em>Today:</em> {r.today}</p>
            </div>
          ))}
        </section>
      ))}
    </>
  );
}

/** An inline marker for a control that is visible but not yet wired. */
export function ComingSoon({ id, children }: { id: string; children: React.ReactNode }) {
  return (
    <span className="soon" title={id}>
      {children}<span className="soon-tag">soon</span>
    </span>
  );
}
