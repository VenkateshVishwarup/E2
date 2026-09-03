import { ReplayComparison } from "./ReplayComparison.js";

export function App() {
  return (
    <main style={{ font: "14px system-ui", maxWidth: 900, margin: "40px auto", padding: 16 }}>
      <h1 style={{ fontSize: 20 }}>Replay — v3 vs v4</h1>
      <ReplayComparison journey="mba-admissions-qualification" a={3} b={4} />
    </main>
  );
}
