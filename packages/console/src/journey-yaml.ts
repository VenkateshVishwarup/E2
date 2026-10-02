/**
 * Starting a new journey from the one on screen.
 *
 * A journey comes into being when its first version is published, so "new
 * journey" is a copy of the current spec under a new name, at version 1. Like
 * the strategy switch, it is a surgical edit on two top-level lines rather than
 * a parse-and-serialise round trip, so the comments that carry the reasoning in
 * a spec survive the copy.
 */

/** The rule the server enforces; checked here too so the form can say why. */
const NAME = /^[a-z0-9][a-z0-9-]*$/;
const MAX_NAME = 120;

/** Why a name cannot start a new journey, or null when it can. */
export function journeyNameProblem(name: string, existing: readonly string[]): string | null {
  if (name.length === 0) return "Give the journey a name.";
  if (name.length > MAX_NAME) return `At most ${MAX_NAME} characters.`;
  if (!NAME.test(name)) {
    return "Lowercase letters, digits and hyphens only, starting with a letter or digit — " +
           "it becomes part of every URL for this journey.";
  }
  if (existing.includes(name)) {
    return `${name} already exists. A change to it is a new version, not a new journey.`;
  }
  return null;
}

/** The spec renamed to `name` and reset to version 1, otherwise byte for byte. */
export function asNewJourney(yaml: string, name: string): string {
  return yaml
    .replace(/^journey:[^\n]*$/m, `journey: ${name}`)
    .replace(/^version:[^\n]*$/m, "version: 1");
}
