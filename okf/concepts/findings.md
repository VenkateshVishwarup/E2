# Findings

`packages/intelligence/src/insights/`

Seven detectors: evidence bottleneck · segment divergence · drop-off · routing
miscalibration · timing · policy friction · version regression.

## The significance bar

Every finding carries its support (`n`). Every comparison carries a 95% interval. **A
finding whose interval spans zero is not emitted**, and neither is one below thirty leads on
either side. Noise in front of a marketer costs the credibility the real findings then need.

Cohort comparisons are **unpaired** — two disjoint groups of different sizes, where pairing
is not merely unnecessary but meaningless. The paired function belongs to replay.

## What the engine will not do

- **It will not guess at "converted".** Ask for findings on a journey with no `conversion:`
  metric and it says so rather than substituting its own definition.
- **It reports what it could not run.** A detector that silently produces nothing reads as a
  clean bill of health, which is the opposite of the truth when the reason is that no
  `PolicyEvaluated` event exists yet.

Routing miscalibration is the one detector allowed to report an interval spanning zero,
because "the score is not separating converters" is precisely what that interval means. It
has three distinct verdicts — leaky, no signal, inverted — and calling any of them by
another's name is worse than saying nothing.

Findings are derived, never stored: a findings table would be a cache of the log that goes
stale the moment a metric definition changes.

Related: [metric predicates](metric-predicates.md) · [copilot](copilot.md)
