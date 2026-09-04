import { useState } from "react";

interface Board {
  a: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  b: { target: string; quality: { qualifiedRate: number; meanCompleteness: number } };
  qualifiedDelta: number;
  qualifiedCi95: [number, number];
  completenessDelta: number;
  correctnessDelta: number | null;
  verdict: "b_better" | "a_better" | "inconclusive";
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

const VERDICT_TEXT: Record<Board["verdict"], string> = {
  b_better: "B wins — the interval clears zero",
  a_better: "A wins — B regressed",
  inconclusive: "Inconclusive — the interval spans zero, so this is not evidence",
};

export function Scoreboard({ journey, a, b }: { journey: string; a: number; b: number }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const go = async () => {
    setBusy(true); setError(null);
    try {
      const r = await fetch("/api/compare", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, a, b, n: 200 }),
      });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error ?? `HTTP ${r.status}`);
      setBoard(await r.json());
    } catch (e) { setError((e as Error).message); }
    finally { setBusy(false); }
  };

  return (
    <>
      <p className="muted">
        The same 200 personas meet both versions, so the comparison is paired.
      </p>
      <button className="btn" disabled={busy} onClick={() => void go()}>
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
          </p>
        </>
      )}
    </>
  );
}
