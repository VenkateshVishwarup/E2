import { useEffect, useState } from "react";

/**
 * The published versions, newest first.
 *
 * `reload` changes whenever something is published, which is what stops the
 * other tabs from talking about v4 forever once someone has published v6. Every
 * screen that names a version reads it from here rather than from a constant.
 */
export function useVersions(journey: string, reload: number): number[] {
  const [loaded, setLoaded] = useState<{ journey: string; versions: number[] }>(
    { journey, versions: [] });

  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch(`/api/journeys/${encodeURIComponent(journey)}/versions`);
        if (r.ok) setLoaded({ journey, versions: (await r.json()).versions as number[] });
      } catch { /* the screens degrade to an empty selector rather than crashing */ }
    })();
  }, [journey, reload]);

  // Tagged with the journey they belong to, so a switch never hands one
  // journey's version numbers to another's screens while the fetch is in flight.
  return loaded.journey === journey ? loaded.versions : NONE;
}

/** One empty list, so a screen keyed on `versions` does not see a new one each render. */
const NONE: number[] = [];

export interface JourneySummary {
  journey: string; versions: number; latest: number; live: number | null;
}

/**
 * Every journey the tenant has published, by name. `null` until the first
 * answer arrives, so a caller can tell "still loading" from "there are none".
 */
export function useJourneys(reload: number): JourneySummary[] | null {
  const [journeys, setJourneys] = useState<JourneySummary[] | null>(null);
  useEffect(() => {
    void (async () => {
      try {
        const r = await fetch("/api/journeys");
        if (r.ok) setJourneys((await r.json()).journeys as JourneySummary[]);
      } catch { /* the picker degrades to the journey already selected */ }
    })();
  }, [reload]);
  return journeys;
}

/** `a` is the older of the two newest versions; `b` the newest. */
export function defaultPair(versions: number[]): { a: number; b: number } | null {
  if (versions.length < 2) return null;
  return { a: versions[1]!, b: versions[0]! };
}

export interface Limits { maxCohort: number; maxRepeats: number; offline: boolean }

/** What the server will actually accept, so a run is never sized to fail. */
export function useLimits(): Limits {
  const [limits, setLimits] = useState<Limits>({ maxCohort: 200, maxRepeats: 1, offline: true });
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
