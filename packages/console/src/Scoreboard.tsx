import { useEffect, useState } from "react";
import { defaultPair } from "./useVersions.js";
import { VersionPicker } from "./VersionPicker.js";
import { useLimits } from "./useVersions.js";

interface Board {
  a: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  b: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: "b_better" | "a_better" | "inconclusive";
  variance?: { qualified: RangeComparison };
}

interface MetricRange { min: number; max: number; mean: number }
interface RangeComparison {
  repeats: number;
  a: MetricRange;
  b: MetricRange;
  verdict: Board["verdict"];
  agreesWithSingleRun: boolean;
  identical: boolean;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const VERDICT_TEXT: Record<Board["verdict"], string> = {
  b_better: "B wins — the interval clears zero",
  a_better: "A wins — B regressed",
  inconclusive: "Inconclusive — the interval spans zero, so this is not evidence",
};

export function Scoreboard({ journey, versions }: { journey: string; versions: number[] }) {
  const { maxCohort, maxRepeats } = useLimits();
  const [repeats, setRepeats] = useState(1);
  // Both arms run every repeat, so the cohort has to shrink as repeats grow or
  // the request is refused for a bill nobody asked for.
  const cohort = Math.min(200, Math.floor(maxCohort / (repeats * 2)));
  const [a, setA] = useState(0);
  const [b, setB] = useState(0);
  useEffect(() => {
    const p = defaultPair(versions);
    if (p) { setA(p.a); setB(p.b); }
  }, [versions]);

  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, a, b, n: cohort, repeats }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setBoard(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        {"The same "}{cohort}{" personas meet both versions, so the comparison is paired."}
        {repeats > 1 && <>{" Each version runs them "}{repeats}{" times, so the verdict is "}
          <strong>range against range</strong>{" rather than one run against one run — which "}
          {"is the difference between a result and a draw you happened to win."}</>}
      </p>
      <div className="pickers">
        <VersionPicker label="A" versions={versions} value={a} onChange={(v) => { setA(v); setBoard(null); }} exclude={b} disabled={busy} />
        <VersionPicker label="B" versions={versions} value={b} onChange={(v) => { setB(v); setBoard(null); }} exclude={a} disabled={busy} />
        <div className="picker">
          <label className="picker-label" htmlFor="compare-repeats">runs each</label>
          <select id="compare-repeats" value={repeats} disabled={busy}
                  onChange={(e) => { setRepeats(Number(e.target.value)); setBoard(null); }}>
            {Array.from({ length: maxRepeats }, (_, i) => i + 1).map((r) => (
              <option key={r} value={r}>{r}</option>
            ))}
          </select>
        </div>
      </div>
      <button className="btn" disabled={busy || !a || !b} onClick={() => void go()}>
        {busy ? "Running both arms…" : `Compare v${a} vs v${b}`}
      </button>

      {error && <p className="err">Comparison failed: {error}</p>}

      {board && (
        <>
          <div className="arms">
            <div className="arm">
              <div className="arm-label">v{a}</div>
              <div className="arm-rate">{pct(board.a.quality.qualifiedRate)}</div>
              <div className="arm-label">qualified</div>
            </div>
            <div className="arm">
              <div className="arm-label">v{b}</div>
              <div className="arm-rate">{pct(board.b.quality.qualifiedRate)}</div>
              <div className="arm-label">qualified</div>
            </div>
          </div>

          <p className="verdict">
            <strong>{board.qualifiedDelta >= 0 ? "+" : ""}{pct(board.qualifiedDelta)}</strong>{" "}
            <span className="muted">
              (95% CI {pct(board.qualifiedCi95[0])} to {pct(board.qualifiedCi95[1])})
            </span>
          </p>
          <p className={board.verdict === "inconclusive" ? "muted" : "ok"}>
            {VERDICT_TEXT[board.verdict]}
            {board.variance && <span className="muted"> — from the first run of each</span>}
          </p>

          {board.variance && <RangeVerdict r={board.variance.qualified} a={a} b={b} />}
        </>
      )}
    </>
  );
}

/**
 * The same question asked of the ranges.
 *
 * Shown beside the single-run verdict rather than instead of it, because the
 * interesting case is when they disagree: one run picked a winner and the
 * ranges say the two versions were never distinguishable.
 */
function RangeVerdict({ r, a, b }: { r: RangeComparison; a: number; b: number }) {
  if (r.identical) {
    return (
      <p className="muted provenance">
        All {r.repeats} runs of each version produced identical figures, so there is no
        range to compare — nothing in this configuration can vary. With a model in the
        loop they would differ.
      </p>
    );
  }
  const band = (m: MetricRange) => `${pct(m.min)} – ${pct(m.max)}`;
  return (
    <div className={r.agreesWithSingleRun ? "alert" : "alert warn"}>
      <strong>Across {r.repeats} runs each</strong>
      <div>
        v{a} qualified {band(r.a)}, v{b} qualified {band(r.b)}.{" "}
        {r.verdict === "inconclusive"
          ? <>The ranges overlap, so these two versions are not distinguishable at{" "}
             {r.repeats} runs.</>
          : <>Every run of v{r.verdict === "b_better" ? b : a} beat every run of
             v{r.verdict === "b_better" ? a : b}.</>}
      </div>
      {!r.agreesWithSingleRun && (
        <div>
          The first run alone said otherwise. Repeating it took the verdict away, which is
          what one draw from each distribution is worth.
        </div>
      )}
    </div>
  );
}
