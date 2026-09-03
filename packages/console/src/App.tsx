import "./styles.css";
import { ReplayComparison } from "./ReplayComparison.js";

export function App() {
  return (
    <main className="wrap">
      <h1>Replay — v3 vs v4</h1>
      <ReplayComparison journey="mba-admissions-qualification" a={3} b={4} />
    </main>
  );
}
