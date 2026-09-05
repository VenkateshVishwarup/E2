import { useEffect, useState } from "react";

/**
 * The published versions, newest first.
 *
 * `reload` changes whenever something is published, which is what stops the
 * other tabs from talking about v4 forever once someone has published v6. Every
 * screen that names a version reads it from here rather than from a constant.
 */
export function useVersions(journey: string, reload: number): number[] {
  const [versions, setVersions] = useState<number[]>([]);

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/versions`);
        if (r.ok) setVersions((await r.json()).versions as number[]);
      } catch { /* the screens degrade to an empty selector rather than crashing */ }
    })();
  }, [journey, reload]);

  return versions;
}

/** `a` is the older of the two newest versions; `b` the newest. */
export function defaultPair(versions: number[]): { a: number; b: number } | null {
  if (versions.length < 2) return null;
  return { a: versions[1]!, b: versions[0]! };
}

export interface Limits { maxCohort: number; offline: boolean }

/** What the server will actually accept, so a run is never sized to fail. */
export function useLimits(): Limits {
  const [limits, setLimits] = useState<Limits>({ maxCohort: 200, offline: true });
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/limits");
        if (r.ok) setLimits(await r.json());
      } catch { /* keep the conservative default */ }
    })();
  }, []);
  return limits;
}
