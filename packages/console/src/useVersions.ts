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
