/** Small deterministic PRNG — replay numbers must be reproducible on stage. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface BootstrapOptions {
  iterations?: number;
  alpha?: number;
  seed?: number;
}

/**
 * Paired bootstrap on the difference in proportions (b - a). Paired because
 * both arms are the same leads replayed through two journey versions — an
 * unpaired interval would overstate the uncertainty.
 */
export function bootstrapDiffCI(
  a: boolean[], b: boolean[], opts: BootstrapOptions = {},
): [number, number] {
  if (a.length !== b.length) throw new Error("arms must be the same length (replay is paired)");
  if (a.length === 0) return [0, 0];

  const { iterations = 2000, alpha = 0.05, seed = 1 } = opts;
  const rand = mulberry32(seed);
  const n = a.length;
  const diffs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < n; j++) {
      const k = Math.floor(rand() * n);
      if (a[k]) sa++;
      if (b[k]) sb++;
    }
    diffs.push(sb / n - sa / n);
  }

  diffs.sort((x, y) => x - y);
  const lo = diffs[Math.floor((alpha / 2) * iterations)]!;
  const hi = diffs[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))]!;
  return [round4(lo), round4(hi)];
}

const round4 = (v: number) => Math.round(v * 10000) / 10000;

/**
 * Unpaired two-sample bootstrap on the difference in proportions (b - a).
 *
 * Distinct from `bootstrapDiffCI` and NOT interchangeable with it. Replay
 * compares the same leads through two journey versions, so the arms are paired
 * and the pairing must be preserved or the interval overstates uncertainty.
 * A cohort comparison — Bangalore against everyone else — is two disjoint
 * groups of different sizes, where pairing is not merely unnecessary but
 * meaningless. Each arm is therefore resampled independently.
 */
export function bootstrapUnpairedDiffCI(
  a: boolean[], b: boolean[], opts: BootstrapOptions = {},
): [number, number] {
  if (a.length === 0 || b.length === 0) return [0, 0];

  const { iterations = 2000, alpha = 0.05, seed = 1 } = opts;
  const rand = mulberry32(seed);
  const diffs: number[] = [];

  for (let i = 0; i < iterations; i++) {
    let sa = 0, sb = 0;
    for (let j = 0; j < a.length; j++) if (a[Math.floor(rand() * a.length)]) sa++;
    for (let j = 0; j < b.length; j++) if (b[Math.floor(rand() * b.length)]) sb++;
    diffs.push(sb / b.length - sa / a.length);
  }

  diffs.sort((x, y) => x - y);
  return [
    round4(diffs[Math.floor((alpha / 2) * iterations)]!),
    round4(diffs[Math.min(iterations - 1, Math.floor((1 - alpha / 2) * iterations))]!),
  ];
}
